import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.ENCRYPTION_KEY = '77'.repeat(32);

/**
 * GET /api/v1/onboarding/state — el estado derivado que refresca el wizard
 * (D33). Lo importante: el shape es exacto, el saldo sale del holder y
 * NUNCA viaja un token ni una contraseña.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantFindFirst: vi.fn(),
  shippingRuleCount: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { findUnique: mocks.tenantFindUnique, findFirst: mocks.tenantFindFirst },
    shippingRule: { count: mocks.shippingRuleCount },
  },
}));

import { GET } from '@/app/api/v1/onboarding/state/route';
import { encrypt } from '../encryption';
import { TRIAL_SHIPMENTS } from '../trial';

const TENANT = {
  shopifyStoreUrl: null,
  shopifyToken: null,
  dashboardSourceEnabled: true,
  dashboardUrl: 'https://autoenvia-dash.vercel.app',
  dashboardToken: encrypt('ae_token_secreto'),
  dacUsername: encrypt('12345678'),
  dacPassword: encrypt('clave-dac'),
  onboardingComplete: false,
  cronSchedule: '0 * * * *',
  isActive: false,
  paymentRuleEnabled: true,
  paymentThreshold: 4000,
  fulfillMode: 'on',
  skuInObservations: false,
  codEnabled: true,
  emailHost: 'smtp.gmail.com',
  emailUser: 'tienda@gmail.com',
  emailPass: encrypt('app-pass'),
  allowedProductTypes: ['Remeras', 'Buzos'],
  consolidateConsecutiveOrders: true,
  consolidationWindowMinutes: 45,
  user: { email: 'juana@tienda.uy', emailVerified: new Date('2026-09-01T00:00:00Z') },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-2', isActive: false, subscriptionStatus: 'INACTIVE',
  });
  // 1ª llamada: el tenant del wizard. 2ª (credit-holder): { userId }.
  // 3ª: el wallet del holder.
  mocks.tenantFindUnique
    .mockResolvedValueOnce(TENANT)
    .mockResolvedValueOnce({ userId: 'u1' })
    .mockResolvedValueOnce({ shipmentCredits: 3, referralBonusCredits: 2 });
  mocks.tenantFindFirst.mockResolvedValue({ id: 'tenant-1' }); // holder = el más viejo
  mocks.shippingRuleCount.mockResolvedValue(2);
});

describe('GET /api/v1/onboarding/state', () => {
  it('sin sesión → 401 sin tocar la base', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled();
  });

  it('200 con el shape exacto, paso derivado y saldo del holder', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toEqual({
      currentStep: 4,
      store: {
        kind: 'dashboard',
        shopifyConnected: false,
        shopifyStoreUrl: null,
        dashboardConnected: true,
        dashboardUrl: 'https://autoenvia-dash.vercel.app',
      },
      dac: { connected: true, username: '12345678' },
      processingMode: 'cada_hora',
      cronSchedule: '0 * * * *',
      onboardingComplete: false,
      isActive: false,
      emailVerified: true,
      email: 'juana@tienda.uy',
      trialShipments: TRIAL_SHIPMENTS,
      balance: { shipmentCredits: 3, referralBonusCredits: 2, total: 5 },
      params: {
        paymentRuleEnabled: true,
        paymentThreshold: 4000,
        fulfillMode: 'on',
        skuInObservations: false,
        codEnabled: true,
        emailConfigured: true,
        allowedProductTypes: ['Remeras', 'Buzos'],
        consolidateConsecutiveOrders: true,
        consolidationWindowMinutes: 45,
        shippingRulesCount: 2,
      },
    });
    // El wallet se lee del holder (tenant-1), no del tenant activo (tenant-2).
    expect(mocks.tenantFindUnique.mock.calls[2][0].where).toEqual({ id: 'tenant-1' });
    expect(mocks.shippingRuleCount.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-2', isActive: true });
  });

  it('nunca devuelve tokens ni contraseñas (ni cifrados ni en claro)', async () => {
    const res = await GET();
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('enc:');
    expect(raw).not.toContain('ae_token_secreto');
    expect(raw).not.toContain('clave-dac');
    expect(raw).not.toContain('app-pass');
    for (const k of ['shopifyToken', 'dashboardToken', 'dacPassword', 'emailPass']) {
      expect(raw).not.toContain(`"${k}"`);
    }
  });

  it('tenant vacío → paso 1, sin DAC, modo del cron por defecto, email sin verificar', async () => {
    mocks.tenantFindUnique.mockReset();
    mocks.tenantFindUnique
      .mockResolvedValueOnce({
        ...TENANT,
        dashboardSourceEnabled: false, dashboardUrl: null, dashboardToken: null,
        dacUsername: null, dacPassword: null,
        cronSchedule: '*/15 * * * *',
        emailHost: null, emailUser: null, emailPass: null,
        allowedProductTypes: null,
        codEnabled: false,
        user: { email: 'nueva@tienda.uy', emailVerified: null },
      })
      .mockResolvedValueOnce({ userId: 'u1' })
      .mockResolvedValueOnce({ shipmentCredits: 5, referralBonusCredits: 0 });
    mocks.shippingRuleCount.mockResolvedValue(0);
    const { data } = await (await GET()).json();
    expect(data.currentStep).toBe(1);
    expect(data.store.kind).toBeNull();
    expect(data.dac).toEqual({ connected: false, username: null });
    expect(data.processingMode).toBe('inmediato');
    expect(data.emailVerified).toBe(false);
    expect(data.balance.total).toBe(5);
    expect(data.params.emailConfigured).toBe(false);
    expect(data.params.allowedProductTypes).toBeNull();
  });

  it('tenant inexistente → 404', async () => {
    mocks.tenantFindUnique.mockReset();
    mocks.tenantFindUnique.mockResolvedValue(null);
    expect((await GET()).status).toBe(404);
  });
});
