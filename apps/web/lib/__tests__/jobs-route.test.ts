import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/v1/jobs — "Procesar ahora". Con D33 el tipo de job sale de la
 * tienda conectada (H10): Shopify → PROCESS_ORDERS (con warm-up del token),
 * Dashboard con Excel → PROCESS_DASHBOARD_ORDERS (sin BullMQ, sin warm-up),
 * sin tienda → 422. Los gates de saldo/actividad no cambian.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  jobCreate: vi.fn(),
  jobUpdate: vi.fn(),
  runLogCreate: vi.fn(),
  warmShopifyToken: vi.fn(),
  getPlanLimit: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { findUnique: mocks.tenantFindUnique, findFirst: mocks.tenantFindFirst },
    job: { findFirst: mocks.jobFindFirst, create: mocks.jobCreate, update: mocks.jobUpdate },
    runLog: { create: mocks.runLogCreate },
  },
}));
vi.mock('@/lib/shopify-access', () => ({ warmShopifyToken: mocks.warmShopifyToken }));
vi.mock('@/lib/mercadopago', () => ({ getPlanLimit: mocks.getPlanLimit }));

import { POST } from '@/app/api/v1/jobs/route';

const HOLDER = {
  isActive: true,
  subscriptionStatus: 'INACTIVE',
  stripePriceId: null,
  shipmentCredits: 5,
  referralBonusCredits: 0,
};
const SHOPIFY_STORE = {
  labelsThisMonth: 0,
  shopifyStoreUrl: 'acme.myshopify.com',
  shopifyToken: 'enc:tok',
  dashboardSourceEnabled: false,
  dashboardUrl: null,
  dashboardToken: null,
};
const EXCEL_STORE = {
  labelsThisMonth: 0,
  shopifyStoreUrl: null,
  shopifyToken: null,
  dashboardSourceEnabled: true,
  dashboardUrl: 'https://autoenvia-dash.vercel.app',
  dashboardToken: 'enc:tok',
};

let originating: Record<string, unknown> = SHOPIFY_STORE;

function post(body?: unknown) {
  return POST(
    new Request('https://autoenvia.com/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.REDIS_URL;
  originating = SHOPIFY_STORE;
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: true, subscriptionStatus: 'INACTIVE',
  });
  // Se distingue cada lectura por su `select`, porque el orden de las
  // llamadas (credit-holder → holder + originante) es detalle del handler.
  mocks.tenantFindUnique.mockImplementation(async (args: { select: Record<string, boolean> }) => {
    if (args.select.userId) return { userId: 'u1' };
    if (args.select.labelsThisMonth) return originating;
    if (args.select.isActive) return HOLDER;
    throw new Error(`select inesperado: ${Object.keys(args.select).join(',')}`);
  });
  mocks.tenantFindFirst.mockResolvedValue({ id: 'tenant-1' });
  mocks.jobFindFirst.mockResolvedValue(null);
  mocks.jobCreate.mockResolvedValue({ id: 'job-1' });
  mocks.warmShopifyToken.mockResolvedValue(undefined);
  mocks.getPlanLimit.mockReturnValue(null);
});

describe('POST /api/v1/jobs — tipo de job según la tienda (D33/H10)', () => {
  it('tienda Shopify → PROCESS_ORDERS, MANUAL, con warm-up del token', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ jobId: 'job-1', type: 'PROCESS_ORDERS' });
    expect(mocks.jobCreate.mock.calls[0][0].data).toEqual({
      tenantId: 'tenant-1', trigger: 'MANUAL', type: 'PROCESS_ORDERS', status: 'PENDING',
    });
    expect(mocks.warmShopifyToken).toHaveBeenCalledWith('tenant-1');
  });

  it('tienda Dashboard con Excel → PROCESS_DASHBOARD_ORDERS, sin warm-up de Shopify', async () => {
    originating = EXCEL_STORE;
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).data.type).toBe('PROCESS_DASHBOARD_ORDERS');
    expect(mocks.jobCreate.mock.calls[0][0].data).toEqual({
      tenantId: 'tenant-1', trigger: 'MANUAL', type: 'PROCESS_DASHBOARD_ORDERS', status: 'PENDING',
    });
    expect(mocks.warmShopifyToken).not.toHaveBeenCalled();
  });

  it('las dos fuentes → manda Shopify', async () => {
    originating = { ...SHOPIFY_STORE, dashboardSourceEnabled: true, dashboardUrl: 'https://d.uy', dashboardToken: 'enc:t' };
    await post({});
    expect(mocks.jobCreate.mock.calls[0][0].data.type).toBe('PROCESS_ORDERS');
  });

  // Revisión 2026-09-02: process-dashboard-orders.job.ts no lee el RunLog
  // `maxOrdersOverride` (trae hasta 100 confirmados y recorta sólo por saldo).
  // "Procesar 1 pedido" en un tenant de Excel despacharía todos.
  describe('límite de pedidos con Dashboard con Excel', () => {
    it('maxOrders=1 → 422 sin crear job ni RunLog', async () => {
      originating = EXCEL_STORE;
      const res = await post({ maxOrders: 1 });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/sólo aplica a tiendas Shopify/);
      expect(mocks.jobCreate).not.toHaveBeenCalled();
      expect(mocks.runLogCreate).not.toHaveBeenCalled();
    });

    it('testMode=true (equivale a 1 pedido) → 422 sin crear job', async () => {
      originating = EXCEL_STORE;
      expect((await post({ testMode: true })).status).toBe(422);
      expect(mocks.jobCreate).not.toHaveBeenCalled();
      expect(mocks.runLogCreate).not.toHaveBeenCalled();
    });

    it('sin límite → 200, job PROCESS_DASHBOARD_ORDERS y sin RunLog de override', async () => {
      originating = EXCEL_STORE;
      const res = await post({});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toMatchObject({ type: 'PROCESS_DASHBOARD_ORDERS', maxOrders: 0, message: 'Job encolado: todos los pedidos' });
      expect(mocks.runLogCreate).not.toHaveBeenCalled();
    });

    /**
     * 🔴 EL BUG QUE ESTO FIJA: el botón "Todos" manda `maxOrders: 0`. La ruta
     * lo perdía (`body?.maxOrders &&` corta en 0) y no escribía el RunLog, así
     * que el worker caía a `tenant.maxOrdersPerRun` — 5 en Curvadivina, 20 en
     * las otras 31 tiendas. "Todos" despachaba 5 o 20.
     */
    it('Shopify con maxOrders=0 (Todos) → RunLog con maxOrdersPerRun=0, que el worker lee como SIN TOPE', async () => {
      const res = await post({ maxOrders: 0 });
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({
        type: 'PROCESS_ORDERS',
        maxOrders: 0,
        message: 'Job encolado: todos los pedidos',
      });
      expect(mocks.runLogCreate).toHaveBeenCalledTimes(1);
      expect(mocks.runLogCreate.mock.calls[0][0].data).toMatchObject({
        message: 'maxOrdersOverride=0',
        meta: { maxOrdersPerRun: 0 },
      });
    });

    it('Excel con maxOrders=0 (Todos) NO se rechaza: es lo único que ese job sabe hacer', async () => {
      originating = EXCEL_STORE;
      const res = await post({ maxOrders: 0 });
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({ type: 'PROCESS_DASHBOARD_ORDERS' });
    });

    it('Shopify con maxOrders=1 sigue igual: job + RunLog maxOrdersOverride=1', async () => {
      const res = await post({ maxOrders: 1 });
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({ type: 'PROCESS_ORDERS', maxOrders: 1 });
      expect(mocks.runLogCreate).toHaveBeenCalledTimes(1);
      expect(mocks.runLogCreate.mock.calls[0][0].data).toMatchObject({
        jobId: 'job-1', tenantId: 'tenant-1', message: 'maxOrdersOverride=1',
      });
    });
  });

  it('sin tienda → 422 y no encola ni calienta token', async () => {
    originating = { ...EXCEL_STORE, dashboardSourceEnabled: false };
    const res = await post({});
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Conectá una tienda/);
    expect(mocks.jobCreate).not.toHaveBeenCalled();
    expect(mocks.warmShopifyToken).not.toHaveBeenCalled();
  });

  it('los gates siguen antes: cuenta pausada → 403 sin mirar la tienda', async () => {
    mocks.tenantFindUnique.mockImplementation(async (args: { select: Record<string, boolean> }) => {
      if (args.select.userId) return { userId: 'u1' };
      if (args.select.labelsThisMonth) return originating;
      return { ...HOLDER, isActive: false };
    });
    expect((await post({})).status).toBe(403);
    expect(mocks.jobCreate).not.toHaveBeenCalled();
  });

  it('job en curso → 409', async () => {
    mocks.jobFindFirst.mockResolvedValue({ id: 'job-viejo' });
    expect((await post({})).status).toBe(409);
    expect(mocks.jobCreate).not.toHaveBeenCalled();
  });

  it('sin sesión → 401', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValueOnce(null);
    expect((await post({})).status).toBe(401);
  });
});
