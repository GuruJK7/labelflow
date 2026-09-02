import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Server component /onboarding (D33): a quién devuelve al dashboard y a
 * quién no. El caso que importa (revisión 2026-09-02): un tenant COMPLETO
 * que perdió la tienda (desinstaló la app desde Shopify → `shopifyToken`
 * null) o DAC. El layout del dashboard lo manda a /onboarding; si esta
 * página lo devolviera, el navegador cortaba con ERR_TOO_MANY_REDIRECTS.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  loadOnboardingState: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/api-utils', () => ({ getAuthenticatedTenant: mocks.getAuthenticatedTenant }));
vi.mock('@/lib/onboarding-state.server', () => ({ loadOnboardingState: mocks.loadOnboardingState }));
vi.mock('@/app/onboarding/_components/OnboardingWizard', () => ({
  OnboardingWizard: (props: { requestedStep: number | null; initial: { currentStep: number } }) => props,
}));

import OnboardingPage from '@/app/onboarding/page';
import type { OnboardingState } from '../onboarding-state';

const COMPLETO_CONECTADO: OnboardingState = {
  currentStep: 6,
  store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
  dac: { connected: true, username: '12345678' },
  processingMode: 'inmediato',
  cronSchedule: '*/15 * * * *',
  onboardingComplete: true,
  isActive: true,
  emailVerified: true,
  email: 'juana@tienda.uy',
  trialShipments: 5,
  balance: { shipmentCredits: 5, referralBonusCredits: 0, total: 5 },
  params: {
    paymentRuleEnabled: false,
    paymentThreshold: 4000,
    fulfillMode: 'on',
    skuInObservations: false,
    codEnabled: false,
    emailConfigured: false,
    allowedProductTypes: null,
    consolidateConsecutiveOrders: false,
    consolidationWindowMinutes: 30,
    shippingRulesCount: 0,
  },
};

async function render(state: OnboardingState, searchParams?: { step?: string; shopify?: string }) {
  mocks.loadOnboardingState.mockResolvedValue(state);
  return OnboardingPage({ searchParams }) as Promise<{ props: { requestedStep: number | null; initial: OnboardingState } }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedTenant.mockResolvedValue({ userId: 'u1', tenantId: 't1', isActive: true, subscriptionStatus: 'ACTIVE' });
});

describe('/onboarding (server component)', () => {
  it('sin sesión → /login con callback', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValue(null);
    await expect(OnboardingPage({})).rejects.toThrow('REDIRECT:/login?callbackUrl=%2Fonboarding');
  });

  it('completo y conectado, sin params → /dashboard', async () => {
    await expect(render(COMPLETO_CONECTADO)).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('completo pero desinstaló la app (tienda perdida) → NO redirige: renderiza el wizard en el paso 2', async () => {
    const el = await render({
      ...COMPLETO_CONECTADO,
      currentStep: 2,
      store: { kind: null, shopifyConnected: false, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(el.props.initial.currentStep).toBe(2);
    expect(el.props.requestedStep).toBeNull();
  });

  it('completo pero sin DAC → NO redirige: wizard en el paso 3', async () => {
    const el = await render({ ...COMPLETO_CONECTADO, currentStep: 3, dac: { connected: false, username: null } });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(el.props.initial.currentStep).toBe(3);
  });

  it('completo y conectado con ?shopify=connected (vuelve del OAuth desde Configuración) → se queda para mostrar el resultado', async () => {
    const el = await render(COMPLETO_CONECTADO, { shopify: 'connected' });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(el.props.requestedStep).toBeNull();
  });

  it('completo y conectado con ?step=4 → wizard en el paso pedido', async () => {
    const el = await render(COMPLETO_CONECTADO, { step: '4' });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(el.props.requestedStep).toBe(4);
  });

  it('no completo → wizard, aunque venga sin params', async () => {
    const el = await render({ ...COMPLETO_CONECTADO, onboardingComplete: false, currentStep: 4 });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(el.props.initial.currentStep).toBe(4);
  });
});
