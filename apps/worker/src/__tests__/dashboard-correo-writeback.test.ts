/**
 * La rama Correo Uruguayo del job de la fuente dashboard tiene que devolverle
 * al origen (DEPO) la guía Y la etiqueta, por el MISMO camino que la rama de
 * DAC (`publicarEtiquetas` → `{ results, ids }`).
 *
 * Hasta el 16-09-2026 sólo llamaba a `marcarCargadas` (`{ ids }`): el panel
 * marcaba el pedido "cargado" sin número ni PDF —un pedido trabado que alguien
 * tenía que completar a mano— aunque AHIVA ya había devuelto las dos cosas.
 * Este test falla sin ese arreglo: con el código viejo `publicarEtiquetas` no se
 * llama nunca y `marcarCargadas` sí.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FuenteDePedidos } from '../fuentes/tipos';
import type { DashboardOrder } from '../dashboard/orders';

const jobUpdate = vi.fn();
const tenantFindUnique = vi.fn();
const psFindMany = vi.fn();
const procesarPedidosCorreo = vi.fn();
const deductCreditsAndStamp = vi.fn();

vi.mock('../db', () => ({
  db: {
    job: { update: (...a: unknown[]) => jobUpdate(...a) },
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
    pendingShipment: { findMany: (...a: unknown[]) => psFindMany(...a) },
  },
}));
vi.mock('../dac/tenant-lock', () => ({
  withTenantDacLock: async (_t: string, _j: string, fn: () => Promise<void>) => fn(),
  DacLockHeldError: class extends Error {},
}));
vi.mock('../credit-holder', () => ({ getCreditHolderTenantId: async (id: string) => id }));
vi.mock('../credits', () => ({ deductCreditsAndStamp: (...a: unknown[]) => deductCreditsAndStamp(...a) }));
vi.mock('../encryption', () => ({
  decryptIfPresent: (v: string | null) => v,
  decryptOrRaw: (v: string | null) => v,
}));
vi.mock('../config', () => ({ getConfig: () => ({}) }));
vi.mock('../storage/health', () => ({
  verificarStorage: async () => ({ escribible: true, error: null }),
  motivoStorageCaido: (e: string) => e,
}));
vi.mock('../correo/process', () => ({
  procesarPedidosCorreo: (...a: unknown[]) => procesarPedidosCorreo(...a),
}));
// Todo lo de la rama DAC se importa pero no se toca en este camino: stubs vacíos
// para que el import del job no arrastre Playwright ni Supabase.
vi.mock('../dac/browser', () => ({ dacBrowser: {} }));
vi.mock('../dac/auth', () => ({ smartLogin: vi.fn() }));
vi.mock('../dac/shipment', () => ({
  createShipment: vi.fn(),
  DuplicateSubmitError: class extends Error {},
  DacAddressRejectedError: class extends Error {},
}));
vi.mock('../dac/orphan-reconcile', () => ({ reconcileOrphansForTenant: vi.fn() }));
vi.mock('../dac/label', () => ({ downloadLabel: vi.fn() }));
const downloadLabelPdf = vi.fn();
vi.mock('../storage/upload', () => ({ uploadLabelPdf: vi.fn(), downloadLabelPdf: (...a: unknown[]) => downloadLabelPdf(...a) }));
vi.mock('../jobs/label-safe-fields', () => ({ buildSafeLabelGeoFields: vi.fn() }));
vi.mock('../jobs/label-items', () => ({ persistLabelItems: vi.fn() }));
vi.mock('../billing/shadow', () => ({ shadowRecordShipment: vi.fn() }));
vi.mock('../logger', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() };
  return { default: l, createStepLogger: () => l };
});

import { processDashboardOrdersJob } from '../jobs/process-dashboard-orders.job';
import { stableNumericId } from '../dashboard/adapter';

const PEDIDO: DashboardOrder = {
  id: 'depo-uuid-1',
  status: 'confirmed',
  buyer_name: 'Ana Pérez',
  items: [{ name: 'Parches', qty: 1, price: 1490 }],
  address: {
    full_name: 'Ana Pérez',
    phone: '099111222',
    department: 'Salto',
    address_line: 'Uruguay 1234',
    city: 'Salto',
  },
};

const tenantCorreo = {
  id: 't-1',
  dacUsername: null,
  dacPassword: null,
  correoEnabled: true,
  correoUser: 'u',
  correoPassword: 'p',
  correoCuenta: null,
  correoSubcuenta: null,
  correoAmbiente: 'prod',
  correoOficinaDevolucion: null,
  pesoDefaultKg: 1,
  codEnabled: false,
  shipmentCredits: 10,
  referralBonusCredits: 0,
  dashboardUrl: 'https://depo.test',
  dashboardToken: 'tok',
  dashboardSourceEnabled: true,
  internalSourceEnabled: false,
};

function fuenteDePrueba() {
  const marcarCargadas = vi.fn().mockResolvedValue(1);
  const publicarEtiquetas = vi.fn().mockResolvedValue(1);
  const informarRevisiones = vi.fn().mockResolvedValue(1);
  const fuente = {
    nombre: 'prueba',
    configurar: () => ({ ok: true as const, ctx: { url: 'https://depo.test', token: 'tok' } }),
    traer: async () => ({ orders: [PEDIDO], saturado: false, sinDireccion: 0 }),
    marcarCargadas,
    publicarEtiquetas,
    informarRevisiones,
  } satisfies FuenteDePedidos<{ url: string; token: string }>;
  return { fuente: fuente as unknown as FuenteDePedidos<never>, marcarCargadas, publicarEtiquetas, informarRevisiones };
}

beforeEach(() => {
  vi.clearAllMocks();
  jobUpdate.mockResolvedValue({});
  tenantFindUnique.mockResolvedValue(tenantCorreo);
  psFindMany.mockResolvedValue([]);
  deductCreditsAndStamp.mockResolvedValue(undefined);
});

describe('fuente dashboard · rama Correo Uruguayo → writeback con guía y PDF', () => {
  it('devuelve tracking + pdf_base64 por publicarEtiquetas y NO usa el camino legacy', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 1, simulados: 0, fallidos: 0, enRevision: 0, bloqueados: 0,
      codigos: ['PC021042235UY'],
      despachados: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), codigo: 'PC021042235UY', etiquetaBase64: 'JVBERi0xLjQ=' }],
      yaEmitidos: [], revisiones: [],
    });
    const { fuente, marcarCargadas, publicarEtiquetas } = fuenteDePrueba();

    await processDashboardOrdersJob('t-1', 'j-1', fuente);

    expect(publicarEtiquetas).toHaveBeenCalledTimes(1);
    expect(publicarEtiquetas.mock.calls[0][1]).toEqual([
      { order_id: 'depo-uuid-1', status: 'labeled', tracking: 'PC021042235UY', pdf_base64: 'JVBERi0xLjQ=' },
    ]);
    expect(marcarCargadas).not.toHaveBeenCalled();
    // Y sigue cobrando el envío como antes (ambiente prod).
    expect(deductCreditsAndStamp).toHaveBeenCalledWith('t-1', 1);
  });

  it('un despachado sin etiqueta viaja igual con su código (el número es lo que impide la guía doble)', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 1, simulados: 0, fallidos: 0, enRevision: 0, bloqueados: 0,
      codigos: ['PC1'],
      despachados: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), codigo: 'PC1' }],
      yaEmitidos: [], revisiones: [],
    });
    const { fuente, publicarEtiquetas } = fuenteDePrueba();

    await processDashboardOrdersJob('t-1', 'j-1', fuente);

    expect(publicarEtiquetas.mock.calls[0][1]).toEqual([
      { order_id: 'depo-uuid-1', status: 'labeled', tracking: 'PC1', pdf_base64: null },
    ]);
  });

  it('los que fueron a revisión NO se devuelven ni se marcan (se mapea por id, no por posición)', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 0, simulados: 0, fallidos: 0, enRevision: 1, bloqueados: 0,
      codigos: [],
      despachados: [],
      yaEmitidos: [], revisiones: [],
    });
    const { fuente, marcarCargadas, publicarEtiquetas } = fuenteDePrueba();

    await processDashboardOrdersJob('t-1', 'j-1', fuente);

    expect(publicarEtiquetas).not.toHaveBeenCalled();
    expect(marcarCargadas).not.toHaveBeenCalled();
  });

  // ── Writeback fallido en la corrida anterior: la guía ya existe ──────────
  it('una guía de Correo YA emitida se vuelve a publicar con el PDF de Storage (writeback anterior fallido)', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 0, simulados: 0, fallidos: 0, enRevision: 0, bloqueados: 1,
      codigos: [],
      despachados: [],
      yaEmitidos: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), codigo: 'PC000000009UY', pdfPath: 't-1/2026-09-16/lbl.pdf' }],
      revisiones: [],
    });
    downloadLabelPdf.mockResolvedValue(Buffer.from('%PDF-1.4'));
    const { fuente, publicarEtiquetas, marcarCargadas } = fuenteDePrueba();

    await processDashboardOrdersJob('t-1', 'j-1', fuente);

    expect(downloadLabelPdf).toHaveBeenCalledWith('t-1/2026-09-16/lbl.pdf');
    expect(publicarEtiquetas.mock.calls[0][1]).toEqual([
      { order_id: 'depo-uuid-1', status: 'labeled', tracking: 'PC000000009UY', pdf_base64: Buffer.from('%PDF-1.4').toString('base64') },
    ]);
    expect(marcarCargadas).not.toHaveBeenCalled();
    // No hubo despacho nuevo: se cobran 0 envíos.
    expect(deductCreditsAndStamp).toHaveBeenCalledWith('t-1', 0);
  });

  it('si retention ya borró el PDF, la guía ya emitida viaja igual sin papel', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 0, simulados: 0, fallidos: 0, enRevision: 0, bloqueados: 1,
      codigos: [],
      despachados: [],
      yaEmitidos: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), codigo: 'PC7', pdfPath: null }],
      revisiones: [],
    });
    const { fuente, publicarEtiquetas } = fuenteDePrueba();

    await processDashboardOrdersJob('t-1', 'j-1', fuente);

    expect(downloadLabelPdf).not.toHaveBeenCalled();
    expect(publicarEtiquetas.mock.calls[0][1]).toEqual([
      { order_id: 'depo-uuid-1', status: 'labeled', tracking: 'PC7', pdf_base64: null },
    ]);
  });

  it('la fuente interna (sin publicarEtiquetas) NO re-marca cargados los yaEmitidos', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 0, simulados: 0, fallidos: 0, enRevision: 0, bloqueados: 1,
      codigos: [],
      despachados: [],
      yaEmitidos: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), codigo: 'PC7', pdfPath: null }],
      revisiones: [],
    });
    const { fuente, marcarCargadas } = fuenteDePrueba();
    delete (fuente as unknown as { publicarEtiquetas?: unknown }).publicarEtiquetas;

    await processDashboardOrdersJob('t-1', 'j-1', fuente);

    expect(marcarCargadas).not.toHaveBeenCalled();
  });

  // ── Los que no salieron, con el motivo, vuelven al origen ────────────────
  it('un pedido en revisión se informa al origen con su motivo, mapeado por id de pedido', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 0, simulados: 0, fallidos: 0, enRevision: 1, bloqueados: 0,
      codigos: [],
      despachados: [],
      yaEmitidos: [],
      revisiones: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), motivo: 'Email inválido o vacío (recibido: vacío).' }],
    });
    const { fuente, informarRevisiones, publicarEtiquetas } = fuenteDePrueba();

    await processDashboardOrdersJob('t-1', 'j-1', fuente);

    expect(informarRevisiones).toHaveBeenCalledTimes(1);
    expect(informarRevisiones.mock.calls[0][1]).toEqual([
      { order_id: 'depo-uuid-1', motivo: 'Email inválido o vacío (recibido: vacío).' },
    ]);
    expect(publicarEtiquetas).not.toHaveBeenCalled();
  });

  it('una fuente sin informarRevisiones (interna) no rompe: el motivo ya está en su etiqueta', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 0, simulados: 0, fallidos: 0, enRevision: 1, bloqueados: 0,
      codigos: [],
      despachados: [],
      yaEmitidos: [],
      revisiones: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), motivo: 'x' }],
    });
    const { fuente } = fuenteDePrueba();
    delete (fuente as unknown as { informarRevisiones?: unknown }).informarRevisiones;

    await expect(processDashboardOrdersJob('t-1', 'j-1', fuente)).resolves.toBeUndefined();
  });

  it('si informar los motivos falla, el job termina igual (best-effort)', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 0, simulados: 0, fallidos: 0, enRevision: 1, bloqueados: 0,
      codigos: [],
      despachados: [],
      yaEmitidos: [],
      revisiones: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), motivo: 'x' }],
    });
    const { fuente, informarRevisiones } = fuenteDePrueba();
    informarRevisiones.mockRejectedValue(new Error('timeout'));

    await expect(processDashboardOrdersJob('t-1', 'j-1', fuente)).resolves.toBeUndefined();
  });

  it('sin publicarEtiquetas (fuente interna) cae al camino de marcar cargadas', async () => {
    procesarPedidosCorreo.mockResolvedValue({
      procesados: 1, simulados: 0, fallidos: 0, enRevision: 0, bloqueados: 0,
      codigos: ['PC1'],
      despachados: [{ shopifyOrderId: String(stableNumericId(PEDIDO.id)), codigo: 'PC1', etiquetaBase64: 'x' }],
      yaEmitidos: [], revisiones: [],
    });
    const { fuente, marcarCargadas } = fuenteDePrueba();
    delete (fuente as unknown as { publicarEtiquetas?: unknown }).publicarEtiquetas;

    await processDashboardOrdersJob('t-1', 'j-1', fuente);

    expect(marcarCargadas).toHaveBeenCalledWith(expect.anything(), ['depo-uuid-1']);
  });
});
