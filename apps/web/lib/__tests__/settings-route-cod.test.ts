import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

process.env.ENCRYPTION_KEY = '99'.repeat(32);

/**
 * PUT/GET /api/v1/settings — contrato que usan el paso 4 y el paso 5 del
 * wizard (D33): `codEnabled` entra y sale (columna existente, H7) y los dos
 * modos de procesamiento pasan la validación del cron.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantUpdate: vi.fn(),
  runLogDeleteMany: vi.fn(),
  labelCount: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { findFirst: mocks.tenantFindFirst, findUnique: mocks.tenantFindUnique, update: mocks.tenantUpdate },
    runLog: { deleteMany: mocks.runLogDeleteMany },
    label: { count: mocks.labelCount },
  },
}));

import { GET, PUT } from '@/app/api/v1/settings/route';

function put(body: unknown) {
  return PUT(
    new NextRequest('https://autoenvia.com/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Revisión 2026-09-02: el contrareembolso vive detrás de COD_FEATURE_ENABLED
  // (lib/cod-feature.ts). Los tests que ya existían asumen el riel prendido.
  process.env.COD_FEATURE_ENABLED = 'true';
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: true, subscriptionStatus: 'ACTIVE',
  });
  mocks.tenantUpdate.mockResolvedValue({});
  mocks.labelCount.mockResolvedValue(0);
});

describe('PUT /api/v1/settings — codEnabled y modo de procesamiento', () => {
  it('codEnabled: true se guarda tal cual', async () => {
    expect((await put({ codEnabled: true })).status).toBe(200);
    expect(mocks.tenantUpdate.mock.calls[0][0].data).toEqual({ codEnabled: true });
  });
  it('codEnabled con un string → 400', async () => {
    expect((await put({ codEnabled: 'si' })).status).toBe(400);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });
  it('los dos modos del paso 5 pasan; */5 no', async () => {
    expect((await put({ cronSchedule: '*/15 * * * *' })).status).toBe(200);
    expect((await put({ cronSchedule: '0 * * * *' })).status).toBe(200);
    expect((await put({ cronSchedule: '*/5 * * * *' })).status).toBe(400);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('PUT/GET /api/v1/settings — COD_FEATURE_ENABLED apagada (fail-closed)', () => {
  beforeEach(() => {
    delete process.env.COD_FEATURE_ENABLED;
  });
  it('PUT codEnabled: true → 422 y no escribe', async () => {
    const res = await put({ codEnabled: true });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/todavía no está disponible/);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });
  it('PUT codEnabled: false se guarda igual (apagar siempre se puede)', async () => {
    expect((await put({ codEnabled: false })).status).toBe(200);
    expect(mocks.tenantUpdate.mock.calls[0][0].data).toEqual({ codEnabled: false });
  });
  it('PUT con otros campos y sin codEnabled no se ve afectado', async () => {
    expect((await put({ skuInObservations: true })).status).toBe(200);
    expect(mocks.tenantUpdate.mock.calls[0][0].data).toEqual({ skuInObservations: true });
  });
  it('GET devuelve codAvailable: false (el form muestra "Próximamente")', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ ...TENANT_ROW, codEnabled: false });
    const { data } = await (await GET()).json();
    expect(data.codAvailable).toBe(false);
    expect(data.codEnabled).toBe(false);
  });
});

const TENANT_ROW = {
  shopifyStoreUrl: 'acme.myshopify.com', shopifyToken: 'enc:a', dacUsername: '12345678', dacPassword: 'enc:c',
  dashboardUrl: null, dashboardToken: 'enc:d', dashboardSourceEnabled: false,
  emailHost: null, emailPort: 587, emailUser: null, emailPass: 'enc:e', emailFrom: null, storeName: null,
  paymentThreshold: 4000, paymentRuleEnabled: false, cronSchedule: '*/15 * * * *', maxOrdersPerRun: 0,
  scheduleSlots: null, isActive: true, subscriptionStatus: 'INACTIVE', stripePriceId: null,
  stripeSubscriptionId: null, currentPeriodEnd: null, labelsThisMonth: 0, labelsTotal: 0, lastRunAt: null,
  apiKey: null, autoFulfillEnabled: true, skuInObservations: false, selfDeliveryEnabled: false,
  selfDeliveryDepartments: null, fulfillMode: 'on', defaultPrinter: null, autoPrintEnabled: false,
  orderSortDirection: 'oldest_first', allowedProductTypes: null, productTypeCache: null,
  consolidateConsecutiveOrders: false, consolidationWindowMinutes: 30, codEnabled: true,
  paymentAutoEnabled: false, paymentCardBrand: null, paymentCardLast4: null, paymentCardCvc: 'enc:f',
};

describe('GET /api/v1/settings — shape', () => {
  it('incluye codEnabled, codAvailable: true con la var prendida, y nunca los secretos (sólo los *Set)', async () => {
    mocks.tenantFindUnique.mockResolvedValue({
      shopifyStoreUrl: 'acme.myshopify.com', shopifyToken: 'enc:a', dacUsername: '12345678', dacPassword: 'enc:c',
      dashboardUrl: null, dashboardToken: 'enc:d', dashboardSourceEnabled: false,
      emailHost: null, emailPort: 587, emailUser: null, emailPass: 'enc:e', emailFrom: null, storeName: null,
      paymentThreshold: 4000, paymentRuleEnabled: false, cronSchedule: '*/15 * * * *', maxOrdersPerRun: 0,
      scheduleSlots: null, isActive: true, subscriptionStatus: 'INACTIVE', stripePriceId: null,
      stripeSubscriptionId: null, currentPeriodEnd: null, labelsThisMonth: 0, labelsTotal: 0, lastRunAt: null,
      apiKey: null, autoFulfillEnabled: true, skuInObservations: false, selfDeliveryEnabled: false,
      selfDeliveryDepartments: null, fulfillMode: 'on', defaultPrinter: null, autoPrintEnabled: false,
      orderSortDirection: 'oldest_first', allowedProductTypes: null, productTypeCache: null,
      consolidateConsecutiveOrders: false, consolidationWindowMinutes: 30, codEnabled: true,
      paymentAutoEnabled: false, paymentCardBrand: null, paymentCardLast4: null, paymentCardCvc: 'enc:f',
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.codEnabled).toBe(true);
    expect(data.codAvailable).toBe(true);
    expect(data).toMatchObject({ shopifyTokenSet: true, dacPasswordSet: true, dashboardTokenSet: true, emailPassSet: true, paymentCardCvcSet: true });
    const raw = JSON.stringify(data);
    for (const k of ['shopifyToken', 'dacPassword', 'dashboardToken', 'emailPass', 'paymentCardCvc']) {
      expect(raw).not.toContain(`"${k}"`);
    }
    expect(raw).not.toContain('enc:');
  });
});
