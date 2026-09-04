import { describe, it, expect, vi, beforeEach } from 'vitest';
import { procesarPedidosCorreo, type CtxCorreo } from '../correo/process';
import { CorreoError, type LocalidadCorreo } from '../correo/types';

/**
 * Regresiones del despacho por Correo Uruguayo.
 *
 * Los tres casos de acá son defectos que ESTUVIERON en el código y que ninguna
 * suite atrapaba. Los tres terminan en lo mismo si vuelven: una segunda guía
 * para un pedido que ya tiene una, con un segundo cobro a un comprador real.
 *
 *  1. El cierre anti-duplicado miraba sólo `carrier === 'CORREO'`, así que un
 *     pedido ya despachado por DAC entraba igual y encima le pisaba la guía.
 *  2. `rechazadoPorAhiva` se deducía de `!err.retryable`, que también es true
 *     para un corte de red — incluido el corte MIENTRAS AHIVA devuelve la
 *     etiqueta, que es justo cuando el envío SÍ existe. Eso borraba el marcador
 *     de idempotencia.
 *  3. `testMode` no puede llamar a AHIVA ni tocar Shopify.
 */

const labelFindUnique = vi.fn();
const labelUpsert = vi.fn();
const labelUpdate = vi.fn();
const labelUpdateMany = vi.fn();
const psFindUnique = vi.fn();
const psUpsert = vi.fn();
const psUpdate = vi.fn();
const psDeleteMany = vi.fn();
const cargaMasiva = vi.fn();
const marcar = vi.fn();
const nota = vi.fn();
const fulfill = vi.fn();
const subir = vi.fn();

vi.mock('../db', () => ({
  db: {
    label: {
      findUnique: (...a: unknown[]) => labelFindUnique(...a),
      upsert: (...a: unknown[]) => labelUpsert(...a),
      update: (...a: unknown[]) => labelUpdate(...a),
      updateMany: (...a: unknown[]) => labelUpdateMany(...a),
    },
    pendingShipment: {
      findUnique: (...a: unknown[]) => psFindUnique(...a),
      upsert: (...a: unknown[]) => psUpsert(...a),
      update: (...a: unknown[]) => psUpdate(...a),
      deleteMany: (...a: unknown[]) => psDeleteMany(...a),
    },
  },
}));
vi.mock('../shopify', () => ({
  fulfillOrderWithTracking: (...a: unknown[]) => fulfill(...a),
  ShopifyAlreadyFulfilledError: class extends Error {},
  ShopifyMissingScopesError: class extends Error {},
  markOrderProcessed: (...a: unknown[]) => marcar(...a),
  addOrderNote: (...a: unknown[]) => nota(...a),
}));
vi.mock('../storage/upload', () => ({ uploadLabelPdf: (...a: unknown[]) => subir(...a) }));
vi.mock('../dac/shipment', () => ({ mergeAddress: (a: string, b: string) => [a, b].filter(Boolean).join(' ') }));
vi.mock('../jobs/label-items', () => ({ persistLabelItems: vi.fn() }));
vi.mock('../correo/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  cargaMasiva: (...a: unknown[]) => cargaMasiva(...a),
  obtenerLocalidadesCorreo: async () => CATALOGO,
}));

const CATALOGO: LocalidadCorreo[] = [
  { nombre: 'Salto', ciudad: 'Salto', departamento: 'Salto', direccion: 'Uruguay 1234',
    codigoPostal: '50000', codigoAHIVA: 1, siteCode: 'SAL', telefono: '4732' },
];

const pedido = () => ({
  id: 900100, name: '#2001', email: 'ana@example.com', total_price: '1490', currency: 'UYU',
  tags: '', phone: '099111222',
  shipping_address: { first_name: 'Ana', last_name: 'Pérez', phone: '099111222',
    address1: 'Uruguay 1234', address2: '', city: 'Salto', province: 'Salto', zip: '50000', country: 'Uruguay' },
  line_items: [{ title: 'Parches', quantity: 1 }],
}) as never;

const ctx = (over: Partial<CtxCorreo> = {}): CtxCorreo => ({
  tenantId: 't-1', jobId: 'j-1', shopifyClient: {} as never, ambiente: 'prod',
  credenciales: { user: 'u', password: 'p' },
  config: { pesoDefaultKg: 1, oficinaDevolucion: null, contraEntrega: false },
  testMode: false, debeFulfillear: false, forceAll: true,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  labelFindUnique.mockResolvedValue(null);
  labelUpsert.mockResolvedValue({ id: 'l-1', createdAt: new Date('2026-01-01') });
  labelUpdate.mockResolvedValue({});
  labelUpdateMany.mockResolvedValue({});
  psFindUnique.mockResolvedValue(null);
  psUpsert.mockResolvedValue({});
  psUpdate.mockResolvedValue({});
  psDeleteMany.mockResolvedValue({});
  subir.mockResolvedValue('/pdf/x.pdf');
});

describe('cierre anti-duplicado: cualquier guía previa, no sólo las de Correo', () => {
  it('un pedido con guía REAL de DAC no se despacha por Correo ni le pisa la guía', async () => {
    labelFindUnique.mockResolvedValue({ dacGuia: '00123456', carrier: null });
    const c = ctx();
    const r = await procesarPedidosCorreo([pedido()], c);

    expect(r.bloqueados).toBe(1);
    expect(r.procesados).toBe(0);
    expect(cargaMasiva).not.toHaveBeenCalled();
    expect(labelUpdate).not.toHaveBeenCalled();
    expect((c.log.warn as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/DAC/);
  });

  it('sigue bloqueando la guía previa de Correo', async () => {
    labelFindUnique.mockResolvedValue({ dacGuia: 'PC021042235UY', carrier: 'CORREO' });
    const r = await procesarPedidosCorreo([pedido()], ctx());
    expect(r.bloqueados).toBe(1);
    expect(cargaMasiva).not.toHaveBeenCalled();
  });

  it('el placeholder PENDING- NO bloquea: todavía no hay guía', async () => {
    labelFindUnique.mockResolvedValue({ dacGuia: 'PENDING-9', carrier: null });
    const r = await procesarPedidosCorreo([pedido()], ctx({ testMode: true }));
    expect(r.bloqueados).toBe(0);
    expect(r.simulados).toBe(1);
  });
});

describe('marcador de idempotencia ante un fallo', () => {
  it('un corte de red NO borra el marcador: el envío puede existir', async () => {
    cargaMasiva.mockRejectedValue(new CorreoError('Fallo de red hablando con AHIVA: undefined', null, false));
    const r = await procesarPedidosCorreo([pedido()], ctx());

    expect(r.fallidos).toBe(1);
    expect(psDeleteMany).not.toHaveBeenCalled();
    expect(labelUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_REVIEW' }) }),
    );
  });

  it('un rechazo EXPLÍCITO de AHIVA sí lo borra: no se creó nada', async () => {
    cargaMasiva.mockRejectedValue(new CorreoError('AHIVA devolvió error 12: destino inválido', 12, false, true));
    const r = await procesarPedidosCorreo([pedido()], ctx());

    expect(r.fallidos).toBe(1);
    expect(psDeleteMany).toHaveBeenCalled();
    expect(labelUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('una respuesta sin código de trazabilidad tampoco borra el marcador', async () => {
    cargaMasiva.mockResolvedValue({ codigoRespuesta: 0, descripcionRespuesta: 'OK', esError: false, envios: [{ codigostrazabilidad: [] }] });
    const r = await procesarPedidosCorreo([pedido()], ctx());

    expect(r.fallidos).toBe(1);
    expect(psDeleteMany).not.toHaveBeenCalled();
  });
});

describe('testMode', () => {
  it('no llama a AHIVA, no sube PDF y no toca Shopify', async () => {
    const r = await procesarPedidosCorreo([pedido()], ctx({ testMode: true }));

    // Una simulación NO es un despacho: `procesados` es lo que el job informa
    // como éxito y lo que se factura, así que tiene que quedar en cero.
    expect(r.procesados).toBe(0);
    expect(r.simulados).toBe(1);
    expect(cargaMasiva).not.toHaveBeenCalled();
    expect(subir).not.toHaveBeenCalled();
    expect(marcar).not.toHaveBeenCalled();
    expect(nota).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
  });
});

/**
 * Regresiones de la auditoría del 04-09-2026. Las tres nacen del mismo error de
 * razonamiento: convertir "no sé" en "no pasó nada". Las tres terminan en una
 * segunda guía con un segundo cobro a un comprador real.
 */
describe('fallar CERRADO cuando no se puede saber', () => {
  it('el error interno 99 de AHIVA NO borra el marcador: el servidor pide reintentar, no dice que rechazó', async () => {
    // Forma exacta con la que client.ts construye el error para el código 99,
    // verificado en vivo contra ahivatest: esError=true, retryable, NO probado.
    cargaMasiva.mockRejectedValue(
      new CorreoError('AHIVA devolvió error 99: Error interno : reintente el pedido', 99, true, false),
    );
    const r = await procesarPedidosCorreo([pedido()], ctx());

    expect(r.fallidos).toBe(1);
    expect(psDeleteMany).not.toHaveBeenCalled();
    expect(labelUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_REVIEW' }) }),
    );
  });

  it('si no se puede leer la etiqueta previa, NO se despacha', async () => {
    // P2024 (timeout del pool) es un evento normal en Supabase bajo carga.
    labelFindUnique.mockRejectedValue(new Error('Timed out fetching a new connection from the pool'));
    const r = await procesarPedidosCorreo([pedido()], ctx());

    expect(cargaMasiva).not.toHaveBeenCalled();
    expect(r.fallidos).toBe(1);
    expect(r.procesados).toBe(0);
  });

  it('si no se puede leer el marcador de idempotencia, NO se despacha', async () => {
    psFindUnique.mockRejectedValue(new Error('server has closed the connection'));
    const r = await procesarPedidosCorreo([pedido()], ctx());

    expect(cargaMasiva).not.toHaveBeenCalled();
    expect(r.fallidos).toBe(1);
  });
});
