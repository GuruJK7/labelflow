import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tag "SIN ETIQUETA" en Shopify.
 *
 * 🔴 LO QUE ESTOS TESTS PROTEGEN es que el predicado NUNCA se "simplifique" a
 * `dacGuia != null AND pdfPath IS NULL`. `pdf-retention.job.ts` borra el PDF y
 * pone `pdfPath = null` a los 15 días a propósito, sin tocar el status: con ese
 * predicado le taggearíamos al comerciante miles de pedidos ya entregados y el
 * tag dejaría de significar algo. El discriminador es el STATUS.
 */
const mocks = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  labelFindMany: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  createClient: vi.fn(),
  resolveAccess: vi.fn(),
  tokenSource: vi.fn(),
  installPacer: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    tenant: { findMany: mocks.tenantFindMany },
    label: { findMany: mocks.labelFindMany },
  },
}));
vi.mock('../logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../shopify', () => ({
  createShopifyClient: mocks.createClient,
  addOrderTag: mocks.addTag,
  removeOrderTag: mocks.removeTag,
}));
vi.mock('../shopify/access', () => ({
  resolveShopifyAccessForJob: mocks.resolveAccess,
  shopifyTokenSourceForTenant: mocks.tokenSource,
}));
// El ritmo real se prueba en sin-etiqueta-ritmo.test.ts contra el bucket emulado.
vi.mock('../shopify/rest-pacer', () => ({
  installShopifyRestPacer: mocks.installPacer,
}));

import { runSinEtiquetaTagging, TAG_SIN_ETIQUETA } from '../jobs/sin-etiqueta-tag.job';

const TENANT = { id: 't1', slug: 'kinevia', shopifyStoreUrl: 'x.myshopify.com', shopifyToken: 'tok' };
/** Lo que devuelve la fachada: el job sólo le toca `.rest` para instalarle el ritmo. */
const CLIENT = { rest: { interceptors: {} } };

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.tenantFindMany.mockResolvedValue([TENANT]);
  mocks.labelFindMany.mockResolvedValue([]);
  mocks.createClient.mockReturnValue(CLIENT);
  mocks.installPacer.mockReturnValue({ esperas: 0, reintentos: 0, bucket: () => null });
  mocks.resolveAccess.mockResolvedValue({ access: 'tok', legacy: true });
  mocks.addTag.mockResolvedValue(undefined);
  mocks.removeTag.mockResolvedValue(true);
});

/** Primera llamada a label.findMany = las rotas; segunda = las sanas. */
function conEtiquetas(rotas: unknown[], sanas: unknown[] = []) {
  mocks.labelFindMany.mockResolvedValueOnce(rotas).mockResolvedValueOnce(sanas);
}

describe('el predicado — la trampa de pdf-retention', () => {
  it('🔴 sólo mira status FAILED y NEEDS_REVIEW, nunca pdfPath a secas', async () => {
    conEtiquetas([]);
    await runSinEtiquetaTagging();
    const where = mocks.labelFindMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['FAILED', 'NEEDS_REVIEW'] });
    expect(where.dacGuia).toEqual({ not: null });
    expect(where.pdfPath).toBeNull();
  });

  it('🔴 CREATED y COMPLETED quedan AFUERA: una etiqueta vieja sin PDF ya se despachó', async () => {
    conEtiquetas([]);
    await runSinEtiquetaTagging();
    const status = mocks.labelFindMany.mock.calls[0][0].where.status.in;
    expect(status).not.toContain('COMPLETED');
    expect(status).not.toContain('CREATED');
  });

  it('acota a una ventana de 30 días: no retro-taggea historia antigua', async () => {
    conEtiquetas([]);
    const ahora = new Date('2026-09-10T12:00:00Z');
    await runSinEtiquetaTagging(ahora);
    const desde = mocks.labelFindMany.mock.calls[0][0].where.createdAt.gte as Date;
    const dias = (ahora.getTime() - desde.getTime()) / 86_400_000;
    expect(dias).toBe(30);
  });
});

describe('poner el tag', () => {
  it('taggea cada pedido roto con SIN ETIQUETA', async () => {
    conEtiquetas([
      { id: 'l1', shopifyOrderId: '111', shopifyOrderName: '#1001' },
      { id: 'l2', shopifyOrderId: '222', shopifyOrderName: '#1002' },
    ]);
    const r = await runSinEtiquetaTagging();
    expect(r.taggeados).toBe(2);
    expect(mocks.addTag).toHaveBeenCalledWith(CLIENT, 111, TAG_SIN_ETIQUETA);
    expect(mocks.addTag).toHaveBeenCalledWith(CLIENT, 222, TAG_SIN_ETIQUETA);
  });

  it('el tag es exactamente "SIN ETIQUETA"', () => {
    expect(TAG_SIN_ETIQUETA).toBe('SIN ETIQUETA');
  });

  it('sin etiquetas rotas ni recuperadas no habla con Shopify', async () => {
    conEtiquetas([], []);
    await runSinEtiquetaTagging();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.addTag).not.toHaveBeenCalled();
  });

  it('un shopifyOrderId no numérico se saltea, no rompe la corrida', async () => {
    conEtiquetas([{ id: 'l1', shopifyOrderId: 'no-numerico', shopifyOrderName: '#1' }]);
    const r = await runSinEtiquetaTagging();
    expect(r.taggeados).toBe(0);
    expect(mocks.addTag).not.toHaveBeenCalled();
  });
});

describe('sacar el tag cuando se recupera', () => {
  it('destaggea sólo las que se arreglaron DESPUÉS, no las recién creadas', async () => {
    const base = new Date('2026-09-10T10:00:00Z');
    conEtiquetas(
      [],
      [
        // arreglada 2 h después de creada → se destaggea
        { id: 'r1', shopifyOrderId: '333', shopifyOrderName: '#3', createdAt: base, updatedAt: new Date(base.getTime() + 2 * 3600_000) },
        // nació sana hace 1 minuto → NO se toca
        { id: 'r2', shopifyOrderId: '444', shopifyOrderName: '#4', createdAt: base, updatedAt: new Date(base.getTime() + 60_000) },
      ],
    );
    const r = await runSinEtiquetaTagging();
    expect(r.destaggeados).toBe(1);
    expect(mocks.removeTag).toHaveBeenCalledTimes(1);
    expect(mocks.removeTag).toHaveBeenCalledWith(CLIENT, 333, TAG_SIN_ETIQUETA);
  });

  it('no cuenta como destaggeada si el tag no estaba', async () => {
    const base = new Date('2026-09-10T10:00:00Z');
    mocks.removeTag.mockResolvedValue(false);
    conEtiquetas([], [
      { id: 'r1', shopifyOrderId: '333', shopifyOrderName: '#3', createdAt: base, updatedAt: new Date(base.getTime() + 2 * 3600_000) },
    ]);
    const r = await runSinEtiquetaTagging();
    expect(r.destaggeados).toBe(0);
  });
});

describe('aislamiento entre tiendas', () => {
  it('una tienda sin token válido no frena a las demás', async () => {
    mocks.tenantFindMany.mockResolvedValue([TENANT, { ...TENANT, id: 't2', slug: 'tam' }]);
    mocks.resolveAccess
      .mockRejectedValueOnce(new Error('sin token'))
      .mockResolvedValueOnce({ access: 'tok', legacy: true });
    mocks.labelFindMany
      .mockResolvedValueOnce([{ id: 'a', shopifyOrderId: '1', shopifyOrderName: '#a' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'b', shopifyOrderId: '2', shopifyOrderName: '#b' }])
      .mockResolvedValueOnce([]);
    const r = await runSinEtiquetaTagging();
    expect(r.errores).toBe(1);
    expect(r.taggeados).toBe(1); // la segunda tienda sí se procesó
  });

  it('ignora tiendas sin Shopify conectado', async () => {
    conEtiquetas([]);
    await runSinEtiquetaTagging();
    expect(mocks.tenantFindMany.mock.calls[0][0].where.shopifyStoreUrl).toEqual({ not: null });
  });

  it('un fallo al taggear un pedido no aborta el resto', async () => {
    mocks.addTag.mockRejectedValueOnce(new Error('429')).mockResolvedValue(undefined);
    conEtiquetas([
      { id: 'l1', shopifyOrderId: '111', shopifyOrderName: '#1' },
      { id: 'l2', shopifyOrderId: '222', shopifyOrderName: '#2' },
    ]);
    const r = await runSinEtiquetaTagging();
    expect(r.errores).toBe(1);
    expect(r.taggeados).toBe(1);
  });
});

describe('el ritmo contra el bucket REST de Shopify (16-09-2026)', () => {
  it('🔴 instala el pacer sobre el cliente REST de cada tienda con trabajo, con las opciones del caller', async () => {
    const ritmo = { sleep: async () => {}, now: () => 0 };
    conEtiquetas([{ id: 'l1', shopifyOrderId: '111', shopifyOrderName: '#1' }]);
    await runSinEtiquetaTagging(new Date(), { ritmo });
    expect(mocks.installPacer).toHaveBeenCalledTimes(1);
    expect(mocks.installPacer).toHaveBeenCalledWith(CLIENT.rest, ritmo);
    // Se instala ANTES de la primera request.
    expect(mocks.installPacer.mock.invocationCallOrder[0]).toBeLessThan(mocks.addTag.mock.invocationCallOrder[0]);
  });

  it('sin opciones, el pacer va con sus defaults (producción)', async () => {
    conEtiquetas([{ id: 'l1', shopifyOrderId: '111', shopifyOrderName: '#1' }]);
    await runSinEtiquetaTagging();
    expect(mocks.installPacer).toHaveBeenCalledWith(CLIENT.rest, undefined);
  });

  it('una tienda sin trabajo no fabrica cliente ni pacer', async () => {
    conEtiquetas([], []);
    await runSinEtiquetaTagging();
    expect(mocks.installPacer).not.toHaveBeenCalled();
  });
});

describe('una corrida no pisa a la anterior', () => {
  it('si la anterior sigue en curso, el tick se saltea sin tocar la base ni Shopify', async () => {
    let soltar!: () => void;
    mocks.addTag.mockImplementationOnce(() => new Promise<void>((resolve) => (soltar = resolve)));
    conEtiquetas([{ id: 'l1', shopifyOrderId: '111', shopifyOrderName: '#1' }]);

    const primera = runSinEtiquetaTagging();
    await vi.waitFor(() => expect(mocks.addTag).toHaveBeenCalledTimes(1));

    const segunda = await runSinEtiquetaTagging();
    expect(segunda).toEqual({ taggeados: 0, destaggeados: 0, tiendas: 0, errores: 0, salteada: true });
    expect(mocks.tenantFindMany).toHaveBeenCalledTimes(1);

    soltar();
    const r = await primera;
    expect(r.taggeados).toBe(1);
    expect(r.salteada).toBeUndefined();

    // Terminada, el próximo tick vuelve a correr.
    conEtiquetas([], []);
    const tercera = await runSinEtiquetaTagging();
    expect(tercera.salteada).toBeUndefined();
    expect(mocks.tenantFindMany).toHaveBeenCalledTimes(2);
  });

  it('si la corrida revienta, la siguiente igual puede correr', async () => {
    mocks.tenantFindMany.mockRejectedValueOnce(new Error('db caída'));
    await expect(runSinEtiquetaTagging()).rejects.toThrow('db caída');
    conEtiquetas([], []);
    const r = await runSinEtiquetaTagging();
    expect(r.salteada).toBeUndefined();
  });
});
