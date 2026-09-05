import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Requisito 2.3.1 del App Store de Shopify, textual:
 *
 *   «Apps must be installed and initiated only on Shopify services. Your app
 *    must not request the manual entry of a myshopify.com URL or a shop's
 *    domain during the installation or configuration flow.»
 *
 * Estos tests son el candado: renderizan el paso 2 del wizard de verdad y
 * afirman que con la flag apagada —que es como va a producción— NO aparece ni
 * el input de dominio ni el campo de Admin API token. Si alguien los devuelve,
 * esto se pone rojo antes de que lo vea un revisor.
 *
 * Se testea el render, no la existencia de la constante, justamente porque lo
 * que la regla prohíbe es lo que el comerciante VE.
 */
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href }, children),
}));

const ORIGINAL = process.env.NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY;

async function renderPaso2() {
  vi.resetModules();
  const { OnboardingWizard } = await import('@/app/onboarding/_components/OnboardingWizard');
  const { TRIAL_SHIPMENTS } = await import('../trial');
  const initial = {
    currentStep: 2 as const,
    store: { kind: null, shopifyConnected: false, shopifyStoreUrl: null, dashboardConnected: false, dashboardUrl: null },
    transportista: { conectado: false, cual: null, dacUsername: null, correoUser: null },
    processingMode: 'inmediato' as const,
    cronSchedule: '*/15 * * * *',
    onboardingComplete: false,
    isActive: false,
    emailVerified: true,
    email: 'juana@tienda.uy',
    trialShipments: TRIAL_SHIPMENTS,
    balance: { shipmentCredits: 5, referralBonusCredits: 0, total: 5 },
    params: {
      paymentRuleEnabled: false, paymentThreshold: 4000, fulfillMode: 'on' as const,
      skuInObservations: false, codEnabled: false, emailConfigured: false,
      allowedProductTypes: null, consolidateConsecutiveOrders: false,
      consolidationWindowMinutes: 30, shippingRulesCount: 0,
    },
  };
  return renderToStaticMarkup(
    createElement(OnboardingWizard, { initial: initial as never, requestedStep: 2 as const, tenantIdActual: 't-actual' })
  );
}

beforeEach(() => { delete process.env.NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY;
  else process.env.NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY = ORIGINAL;
});

describe('requisito 2.3.1 — nada de dominio ni token a mano', () => {
  it('con la flag apagada (producción) el paso 2 no pide el dominio .myshopify.com', async () => {
    const html = await renderPaso2();
    expect(html).not.toContain('mitienda.myshopify.com');
    expect(html).not.toContain('El dominio que termina en .myshopify.com');
  });

  it('con la flag apagada tampoco ofrece pegar un Admin API token', async () => {
    const html = await renderPaso2();
    expect(html).not.toContain('shpat_');
    expect(html).not.toContain('Admin API Access Token');
    expect(html).not.toContain('Conectar a mano con un token');
  });

  it('el comerciante no queda sin camino: se le ofrece instalar desde el App Store', async () => {
    const html = await renderPaso2();
    expect(html).toMatch(/App Store de Shopify/);
  });

  it('la opción del Excel sigue viva: apagar lo manual no rompe el otro camino', async () => {
    const html = await renderPaso2();
    expect(html).toContain('Dashboard con Excel');
  });

  it('con la flag prendida vuelve el camino manual, para soporte', async () => {
    process.env.NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY = 'true';
    const html = await renderPaso2();
    expect(html).toContain('mitienda.myshopify.com');
    expect(html).toContain('Admin API Access Token');
  });
});
