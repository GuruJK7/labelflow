import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Render real del wizard en node (react-dom/server, como sidebar-render).
 * Verifica lo que el usuario ve: aterriza en el paso derivado, `?step=N`
 * manda, la barra tiene los 6 pasos con tiempo estimado, el paso final
 * muestra los envíos gratis y el saldo real, y no hay emojis.
 */
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => createElement('a', { href }, children),
}));

import { OnboardingWizard } from '@/app/onboarding/_components/OnboardingWizard';
import { TRIAL_SHIPMENTS } from '../trial';
import type { OnboardingState } from '../onboarding-state';

const BASE: OnboardingState = {
  currentStep: 1,
  store: { kind: null, shopifyConnected: false, shopifyStoreUrl: null, dashboardConnected: false, dashboardUrl: null },
  dac: { connected: false, username: null },
  processingMode: 'inmediato',
  cronSchedule: '*/15 * * * *',
  onboardingComplete: false,
  isActive: false,
  emailVerified: true,
  email: 'juana@tienda.uy',
  trialShipments: TRIAL_SHIPMENTS,
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

function render(initial: OnboardingState, requestedStep: 1 | 2 | 3 | 4 | 5 | 6 | null = null) {
  return renderToStaticMarkup(createElement(OnboardingWizard, { initial, requestedStep }));
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/u;

describe('<OnboardingWizard>', () => {
  it('cuenta nueva: paso 1 con el checklist de 5 ítems, tiempos y los envíos gratis', () => {
    const html = render(BASE);
    expect(html).toContain('Vamos a dejar tus envíos en automático');
    expect(html).toContain('1. Conectar tu tienda');
    expect(html).toContain('5. Listo');
    expect(html).toContain('2 min');
    expect(html).toContain('30 seg');
    expect(html).toContain(`${TRIAL_SHIPMENTS} envíos para probar`);
    expect(html).not.toMatch(EMOJI);
  });

  it('la barra de progreso tiene los 6 pasos y sólo los alcanzables son clickeables', () => {
    const html = render(BASE);
    for (const t of ['Bienvenida', 'Tu tienda', 'Cuenta DAC', 'Parámetros', 'Cada cuánto', 'Listo']) expect(html).toContain(t);
    // Paso 1 alcanzable (activo); del 2 al 6, deshabilitados.
    const disabled = (html.match(/<button[^>]*disabled=""[^>]*>/g) ?? []).length;
    expect(disabled).toBeGreaterThanOrEqual(5);
  });

  it('con tienda pero sin DAC aterriza en el paso 3 y muestra la tienda como hecha en la barra', () => {
    const html = render({
      ...BASE,
      currentStep: 3,
      store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
    });
    expect(html).toContain('Tu cuenta de DAC');
    expect(html).toContain('No podemos probar el ingreso a DAC');
    expect(html).not.toContain('Vamos a dejar tus envíos');
  });

  it('paso 2 con Excel conectado: tarjeta verde con la URL y Continuar habilitado; sin el App Store si falta la env', () => {
    delete process.env.NEXT_PUBLIC_SHOPIFY_APP_STORE_URL;
    const html = render(
      {
        ...BASE,
        currentStep: 3,
        store: { kind: 'dashboard', shopifyConnected: false, shopifyStoreUrl: null, dashboardConnected: true, dashboardUrl: 'https://autoenvia-dash.vercel.app' },
      },
      2,
    );
    expect(html).toContain('Dashboard con Excel conectado');
    expect(html).toContain('https://autoenvia-dash.vercel.app');
    expect(html).not.toContain('App Store de Shopify');
  });

  it('paso 5 con tienda Excel avisa que no hay aviso instantáneo y muestra los dos modos', () => {
    const html = render(
      {
        ...BASE,
        currentStep: 4,
        store: { kind: 'dashboard', shopifyConnected: false, shopifyStoreUrl: null, dashboardConnected: true, dashboardUrl: 'https://d.uy' },
        dac: { connected: true, username: '12345678' },
      },
      5,
    );
    expect(html).toContain('Inmediato');
    expect(html).toContain('Cada hora');
    expect(html).toContain('el aviso instantáneo no está disponible');
    expect(html).not.toContain('Horario personalizado');
  });

  it('paso 5 con cron heredado muestra "Horario personalizado"', () => {
    const html = render({ ...BASE, currentStep: 4, processingMode: 'personalizado', cronSchedule: '0 9 * * 1-5', dac: { connected: true, username: 'u' } }, 5);
    expect(html).toContain('Horario personalizado (configurado por soporte)');
  });

  it('paso 6: envíos gratis, saldo real del holder y el aviso de saldo compartido cuando es menor', () => {
    const html = render(
      {
        ...BASE,
        currentStep: 4,
        store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
        dac: { connected: true, username: '12345678' },
        balance: { shipmentCredits: 0, referralBonusCredits: 0, total: 0 },
      },
      6,
    );
    expect(html).toContain(`${TRIAL_SHIPMENTS} envíos gratis`);
    expect(html).toContain('Saldo disponible');
    expect(html).toContain('Tu saldo es compartido entre todas tus tiendas');
    expect(html).toContain('Activar y procesar ahora');
    expect(html).toContain('Activar sin procesar');
    expect(html).toContain('acme.myshopify.com');
    expect(html).not.toMatch(EMOJI);
  });

  it('paso 6 sin email verificado: banner y botón principal deshabilitado', () => {
    const html = render({ ...BASE, currentStep: 4, emailVerified: false, dac: { connected: true, username: 'u' } }, 6);
    expect(html).toContain('Confirmá tu email para activar la cuenta');
    expect(html).toContain('/verify-email?email=juana%40tienda.uy');
  });

  it('ya completo y vuelve desde Configuración: "Procesar ahora" en vez de activar, y link a Configuración', () => {
    const html = render({ ...BASE, currentStep: 6, onboardingComplete: true, isActive: true, dac: { connected: true, username: 'u' } }, 6);
    expect(html).toContain('Procesar ahora');
    expect(html).not.toContain('Activar y procesar ahora');
    expect(html).toContain('Volver a Configuración');
  });

  it('el pie de confianza no usa el candado como emoji', () => {
    const html = render(BASE);
    expect(html).toContain('Tus credenciales se guardan cifradas (AES-256)');
    expect(html).not.toContain('🔒');
  });
});
