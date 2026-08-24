import { describe, it, expect, vi, beforeEach } from 'vitest';
import { procesarPedidosRepartoPropio } from '../self-delivery/process';
import { codigoSeguimiento } from '../self-delivery/tracking';

/**
 * Tests del pipeline de reparto propio.
 *
 * Lo que se protege aca son las tres cosas que, si se rompen, no fallan de
 * forma visible sino que producen un envio mal despachado:
 *
 *  1. Que el pedido NO toque DAC.
 *  2. Que el fulfillment de Shopify salga SIN link de rastreo de DAC (si no, el
 *     cliente recibe por mail un seguimiento que en DAC no existe).
 *  3. Que el codigo de la etiqueta sea el mismo si el cron reintenta el pedido.
 */

const upsert = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const fulfill = vi.fn();
const marcar = vi.fn();
const nota = vi.fn();
const subir = vi.fn();
const render = vi.fn();

vi.mock('../db', () => ({
  db: {
    label: {
      upsert: (...a: unknown[]) => upsert(...a),
      update: (...a: unknown[]) => update(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
  },
}));
vi.mock('../shopify/fulfillment', () => ({
  fulfillOrderWithTracking: (...a: unknown[]) => fulfill(...a),
  ShopifyAlreadyFulfilledError: class extends Error {},
  ShopifyMissingScopesError: class extends Error {},
}));
vi.mock('../shopify/orders', () => ({
  markOrderProcessed: (...a: unknown[]) => marcar(...a),
  addOrderNote: (...a: unknown[]) => nota(...a),
}));
vi.mock('../storage/upload', () => ({ uploadLabelPdf: (...a: unknown[]) => subir(...a) }));
vi.mock('../self-delivery/render', () => ({
  renderEtiquetaPdf: (...a: unknown[]) => render(...a),
  cerrarRenderer: vi.fn(),
}));


const pedido = (over: Record<string, unknown> = {}) => ({
  id: 5544332211,
  name: '#1234',
  email: 'ana@example.com',
  total_price: '2490',
  currency: 'UYU',
  tags: '',
  phone: null,
  shipping_address: {
    first_name: 'Ana', last_name: 'Pérez', phone: '099111222',
    address1: 'Sarandí 742', address2: 'Apto 3',
    city: 'Punta del Este', province: 'Maldonado', zip: '20100', country: 'UY',
  },
  line_items: [], note: null, note_attributes: null,
  ...over,
}) as never;

const veredicto = { esRepartoPropio: true, departamento: 'Maldonado', motivo: 'x', senales: { porCiudad: 'Maldonado', porZip: 'Maldonado', porProvince: 'Maldonado' } };

const ctx = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-1',
  jobId: 'job-1',
  nombreTienda: 'Mi Tienda',
  shopifyClient: {} as never,
  testMode: false,
  debeFulfillear: true,
  forceAll: false,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  ...over,
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({ id: 'label-1' });
  update.mockResolvedValue({});
  updateMany.mockResolvedValue({});
  subir.mockResolvedValue({ path: 'tenant-1/2026-08-24/label-1.pdf', error: null });
  render.mockResolvedValue(Buffer.from('%PDF-fake'));
  fulfill.mockResolvedValue(undefined);
  marcar.mockResolvedValue(undefined);
  nota.mockResolvedValue(undefined);
});

describe('pipeline de reparto propio', () => {
  it('emite la etiqueta y marca el Label como COMPLETED', async () => {
    const r = await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx());
    expect(r.procesados).toBe(1);
    expect(r.fallidos).toBe(0);
    expect(render).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    );
  });

  it('guarda la guia con prefijo LF- y es la misma en un reintento', async () => {
    const esperado = codigoSeguimiento('tenant-1', '5544332211');
    expect(esperado.startsWith('LF-')).toBe(true);

    await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx());
    expect(upsert.mock.calls[0][0].create.dacGuia).toBe(esperado);

    // Reintento del mismo pedido: mismo codigo, no uno nuevo.
    vi.clearAllMocks();
    upsert.mockResolvedValue({ id: 'label-1' });
    subir.mockResolvedValue({ path: 'p', error: null });
    render.mockResolvedValue(Buffer.from('x'));
    await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx());
    expect(upsert.mock.calls[0][0].create.dacGuia).toBe(esperado);
  });

  it('el fulfillment de Shopify NO lleva link de rastreo de DAC', async () => {
    await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx());
    expect(fulfill).toHaveBeenCalledTimes(1);
    const [, orderId, guia, trackingUrl, , opts] = fulfill.mock.calls[0];
    expect(orderId).toBe(5544332211);
    expect(guia.startsWith('LF-')).toBe(true);
    expect(trackingUrl).toBeUndefined();
    expect(opts).toEqual({ company: 'Reparto propio', sinUrl: true });
  });

  it('la etiqueta no pide cobrar (el worker solo ve pedidos ya pagados)', async () => {
    await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx());
    expect(render.mock.calls[0][0].cobrarUyu).toBeNull();
    expect(render.mock.calls[0][0].remitente).toBe('Mi Tienda');
    expect(render.mock.calls[0][0].destinatario.nombre).toBe('Ana Pérez');
    expect(render.mock.calls[0][0].destinatario.telefono).toBe('099111222');
  });

  it('NO pierde el apartamento: la calle va en direccion y el acceso en la nota', async () => {
    // mergeAddress manda "Apto 3" a extraObs (en DAC eso va a Observaciones).
    // Si no lo pasaramos a la nota, el repartidor llegaria al edificio sin
    // saber a que puerta tocar.
    await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx());
    const d = render.mock.calls[0][0];
    expect(d.destinatario.direccion).toContain('Sarandí 742');
    expect(String(d.nota)).toContain('Apto 3');
  });

  it('combina el acceso con la nota del pedido de Shopify', async () => {
    await procesarPedidosRepartoPropio(
      [{ order: pedido({ note: 'Llamar antes' }), veredicto }],
      ctx(),
    );
    const nota = String(render.mock.calls[0][0].nota);
    expect(nota).toContain('Apto 3');
    expect(nota).toContain('Llamar antes');
  });

  it('en testMode no toca Shopify ni sube el PDF', async () => {
    await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx({ testMode: true }));
    expect(subir).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
    expect(marcar).not.toHaveBeenCalled();
  });

  it('con el fulfillment apagado no marca preparado, pero igual emite la etiqueta', async () => {
    const r = await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx({ debeFulfillear: false }));
    expect(r.procesados).toBe(1);
    expect(fulfill).not.toHaveBeenCalled();
    expect(marcar).toHaveBeenCalled(); // el tag sí, para que quede rastro
  });

  it('un pedido sin direccion se cuenta como fallido y no rompe el lote', async () => {
    const r = await procesarPedidosRepartoPropio(
      [{ order: pedido({ shipping_address: null }), veredicto }, { order: pedido({ id: 999 }), veredicto }],
      ctx(),
    );
    expect(r.fallidos).toBe(1);
    expect(r.procesados).toBe(1);
  });

  it('si el render falla, el Label queda FAILED y el resto del lote sigue', async () => {
    render.mockRejectedValueOnce(new Error('chromium se cayo'));
    const r = await procesarPedidosRepartoPropio(
      [{ order: pedido(), veredicto }, { order: pedido({ id: 777, name: '#777' }), veredicto }],
      ctx(),
    );
    expect(r.fallidos).toBe(1);
    expect(r.procesados).toBe(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('si no se puede subir el PDF, la etiqueta igual se da por emitida', async () => {
    subir.mockResolvedValueOnce({ path: '', error: 'bucket caido' });
    const r = await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx());
    expect(r.procesados).toBe(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', pdfPath: null }) }),
    );
  });

  it('deja nota en Shopify explicando por que no hay guia DAC', async () => {
    await procesarPedidosRepartoPropio([{ order: pedido(), veredicto }], ctx());
    const texto = nota.mock.calls[0][2] as string;
    expect(texto).toContain('reparto propio');
    expect(texto).toContain('Maldonado');
    expect(texto).toContain('No se generó guía DAC');
  });
});
