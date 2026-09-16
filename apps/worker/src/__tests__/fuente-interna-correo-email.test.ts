/**
 * Un pedido de la carga propia CON mail sale por Correo Uruguayo; sin mail, va
 * a revisión por ese motivo. [16-09-2026]
 *
 * Es el recorrido entero de la fuente interna hasta la puerta de AHIVA:
 * `PedidoInterno` → `aDashboardOrder` → `toShopifyOrder` → `procesarPedidosCorreo`,
 * con el cliente SOAP de AHIVA mockeado igual que en correo-process.test.ts.
 *
 * 🔴 Falla sin el fix de `fuentes/interna.ts` (`email: texto(p.email)`): con el
 * código anterior el mail moría en la traducción, `order.email` llegaba vacío y
 * `construirEnvio` (correo/validate.ts) mandaba el pedido a NEEDS_REVIEW con
 * «Email inválido o vacío» — en cada corrida, sin salir nunca, y sin que nada
 * en la pantalla de Pedidos permitiera corregirlo porque el formulario tampoco
 * tenía el campo. Verificado neutralizando el fix a mano: el primer caso cae.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { procesarPedidosCorreo, type CtxCorreo } from '../correo/process';
import type { LocalidadCorreo } from '../correo/types';
import { aDashboardOrder, type FilaPedidoInterno } from '../fuentes/interna';
import { toShopifyOrder, stableNumericId } from '../dashboard/adapter';

const labelFindUnique = vi.fn();
const labelUpsert = vi.fn();
const labelUpdate = vi.fn();
const labelUpdateMany = vi.fn();
const psFindUnique = vi.fn();
const psUpsert = vi.fn();
const psUpdate = vi.fn();
const psDeleteMany = vi.fn();
const cargaMasiva = vi.fn();
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
  fulfillOrderWithTracking: vi.fn(),
  ShopifyAlreadyFulfilledError: class extends Error {},
  ShopifyMissingScopesError: class extends Error {},
  markOrderProcessed: vi.fn(),
  addOrderNote: vi.fn(),
}));
vi.mock('../storage/upload', () => ({ uploadLabelPdf: (...a: unknown[]) => subir(...a) }));
vi.mock('../jobs/label-items', () => ({ persistLabelItems: vi.fn() }));
vi.mock('../billing/shadow', () => ({ shadowRecordShipment: vi.fn() }));
vi.mock('../correo/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  cargaMasiva: (...a: unknown[]) => cargaMasiva(...a),
  obtenerLocalidadesCorreo: async () => CATALOGO,
}));

const CATALOGO: LocalidadCorreo[] = [
  { nombre: 'Salto', ciudad: 'Salto', departamento: 'Salto', direccion: 'Uruguay 1234',
    codigoPostal: '50000', codigoAHIVA: 1, siteCode: 'SAL', telefono: '4732' },
];

/** Una fila de `PedidoInterno` tal como la deja el formulario o el Excel. */
function filaInterna(overrides: Partial<FilaPedidoInterno> = {}): FilaPedidoInterno {
  return {
    id: 'cmu1phiyx0007mrvlu2e06tpi',
    nombre: 'Ana Pérez',
    telefono: '099111222',
    documento: null,
    email: 'ana.perez@example.com',
    departamento: 'Salto',
    localidad: 'Salto',
    direccion: 'Uruguay 1234',
    agencia: null,
    referencia: null,
    items: [{ nombre: 'Parches', cantidad: 1, precio: 1490 }],
    totalUyu: 1490,
    contraEntrega: false,
    observaciones: null,
    ...overrides,
  };
}

/** El mismo camino que recorre el job: fuente interna → adaptador → Correo. */
const ordenDe = (f: FilaPedidoInterno) => toShopifyOrder(aDashboardOrder(f)).order;

const ctx = (over: Partial<CtxCorreo> = {}): CtxCorreo => ({
  tenantId: 't-1',
  jobId: 'j-1',
  // Los pedidos de la carga propia no viven en Shopify.
  shopifyClient: null,
  ambiente: 'prod',
  credenciales: { user: 'u', password: 'p' },
  config: { pesoDefaultKg: 1, oficinaDevolucion: null, contraEntrega: false },
  testMode: false,
  debeFulfillear: false,
  forceAll: false,
  catalogo: CATALOGO,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  labelFindUnique.mockResolvedValue(null);
  labelUpsert.mockResolvedValue({ id: 'l-1', createdAt: new Date('2026-09-16') });
  labelUpdate.mockResolvedValue({});
  labelUpdateMany.mockResolvedValue({});
  psFindUnique.mockResolvedValue(null);
  psUpsert.mockResolvedValue({});
  psUpdate.mockResolvedValue({});
  psDeleteMany.mockResolvedValue({});
  subir.mockResolvedValue({ path: 't-1/2026-09-16/l-1.pdf', error: null });
});

describe('carga propia → Correo Uruguayo: el mail del destinatario', () => {
  it('🔴 CON mail, el pedido pasa el pre-vuelo y AHIVA emite la guía: no va a revisión por «Email inválido o vacío»', async () => {
    cargaMasiva.mockResolvedValue({
      codigoRespuesta: 0, descripcionRespuesta: 'OK', esError: false,
      envios: [{ codigostrazabilidad: ['PC021042235UY'], etiquetasBase64: 'JVBERi0xLjQK' }],
    });

    const r = await procesarPedidosCorreo([ordenDe(filaInterna())], ctx());

    expect(r.enRevision).toBe(0);
    expect(r.revisiones).toEqual([]);
    expect(r.procesados).toBe(1);
    expect(r.despachados).toEqual([
      { shopifyOrderId: String(stableNumericId('cmu1phiyx0007mrvlu2e06tpi')), codigo: 'PC021042235UY', etiquetaBase64: 'JVBERi0xLjQK' },
    ]);
    // Y el mail que escribió el comerciante es exactamente el que recibe AHIVA,
    // que es quien le avisa al comprador que el paquete llegó.
    expect(cargaMasiva).toHaveBeenCalledTimes(1);
    const envio = (cargaMasiva.mock.calls[0][0] as { envios: Array<{ destinatario: { mail: string } }> }).envios[0];
    expect(envio.destinatario.mail).toBe('ana.perez@example.com');
  });

  it('en modo prueba, con mail, se simula sin llamar a AHIVA (misma validación, cero guías)', async () => {
    const r = await procesarPedidosCorreo([ordenDe(filaInterna())], ctx({ testMode: true }));
    expect(r.simulados).toBe(1);
    expect(r.enRevision).toBe(0);
    expect(cargaMasiva).not.toHaveBeenCalled();
  });

  it('SIN mail sigue yendo a revisión, con un motivo que una persona puede corregir desde /pedidos', async () => {
    // Este es el comportamiento de siempre: lo que cambió es que ahora el mail
    // PUEDE cargarse. El pedido no sale, y el motivo lo dice.
    const r = await procesarPedidosCorreo([ordenDe(filaInterna({ email: null }))], ctx());

    expect(r.enRevision).toBe(1);
    expect(r.procesados).toBe(0);
    expect(r.revisiones).toHaveLength(1);
    expect(r.revisiones[0].motivo).toMatch(/email/i);
    expect(cargaMasiva).not.toHaveBeenCalled();
  });
});
