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
  transportista: { conectado: false, cual: null, dacUsername: null, correoUser: null },
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
  return renderToStaticMarkup(createElement(OnboardingWizard, { initial, requestedStep, tenantIdActual: 't-actual' }));
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
    for (const t of ['Bienvenida', 'Tu tienda', 'Transportista', 'Parámetros', 'Cada cuánto', 'Listo']) expect(html).toContain(t);
    // Paso 1 alcanzable (activo); del 2 al 6, deshabilitados.
    const disabled = (html.match(/<button[^>]*disabled=""[^>]*>/g) ?? []).length;
    expect(disabled).toBeGreaterThanOrEqual(5);
  });

  /**
   * 🔴 El wizard era una trampa: `/dashboard` rebota a `/onboarding` cuando a la
   * tienda le falta algo, y `/onboarding` sólo dejaba salir con TODO completo.
   * Una tienda a medio configurar dejaba al usuario encerrado, y el selector de
   * tienda vive en el layout del dashboard — al que no podía llegar.
   */
  it('siempre ofrece una salida: cerrar sesión', () => {
    const html = render({ ...BASE, currentStep: 3 });
    expect(html).toContain('Cerrar sesión');
  });

  /**
   * El paso 3 dejó de ser "Cuenta DAC". Quien elige Correo Uruguayo tiene que
   * poder cargarlo acá: antes no había dónde, el alta exigía DAC y la cuenta
   * no se activaba nunca.
   */
  it('el paso 3 ofrece los DOS transportistas, no sólo DAC', () => {
    const html = render({
      ...BASE,
      currentStep: 3,
      store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
    });
    expect(html).toContain('DAC');
    expect(html).toContain('Correo Uruguayo');
    expect(html).toContain('Entrega en agencia');
  });

  it('con Correo ya conectado el paso 3 lo muestra como hecho, sin pedir DAC', () => {
    const html = render({
      ...BASE,
      currentStep: 3,
      store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
      transportista: { conectado: true, cual: 'CORREO', dacUsername: null, correoUser: '51654286' },
    });
    expect(html).toContain('Correo Uruguayo conectado');
    expect(html).toContain('51654286');
    expect(html).not.toContain('No podemos probar el ingreso a DAC');
  });

  it('con tienda pero sin DAC aterriza en el paso 3 y muestra la tienda como hecha en la barra', () => {
    const html = render({
      ...BASE,
      currentStep: 3,
      store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
    });
    expect(html).toContain('Tu transportista');
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

  it('paso 4 con Dashboard con Excel: un solo aviso, sin los parámetros que el job de Dashboard ignora', () => {
    const html = render(
      {
        ...BASE,
        currentStep: 4,
        store: { kind: 'dashboard', shopifyConnected: false, shopifyStoreUrl: null, dashboardConnected: true, dashboardUrl: 'https://d.uy' },
        transportista: { conectado: true, cual: 'DAC', dacUsername: '12345678', correoUser: null },
      },
      4,
    );
    expect(html).toContain('Con Dashboard con Excel no hay parámetros para ajustar');
    expect(html).toContain('aplican sólo a tiendas Shopify');
    // Ninguno de los 8 bloques (por id de sección) ni el bloque de modo (paso 5).
    for (const id of ['quien-paga', 'envio-gratis', 'pedidos-seguidos', 'productos', 'preparado', 'sku', 'contrareembolso', 'email', 'orden', 'modo']) {
      expect(html).not.toContain(`id="param-${id}"`);
    }
    expect(html).toContain('id="param-dashboard"');
    expect(html).not.toContain('Cargando tus parámetros');
    expect(html).toContain('Continuar');
  });

  it('paso 4 con Shopify: carga los parámetros (SSR muestra el estado de carga, no el aviso de Excel)', () => {
    const html = render(
      {
        ...BASE,
        currentStep: 4,
        store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
        transportista: { conectado: true, cual: 'DAC', dacUsername: '12345678', correoUser: null },
      },
      4,
    );
    expect(html).toContain('Cargando tus parámetros');
    expect(html).not.toContain('Con Dashboard con Excel no hay parámetros para ajustar');
  });

  it('paso 5 con tienda Excel avisa que no hay aviso instantáneo y muestra los dos modos', () => {
    const html = render(
      {
        ...BASE,
        currentStep: 4,
        store: { kind: 'dashboard', shopifyConnected: false, shopifyStoreUrl: null, dashboardConnected: true, dashboardUrl: 'https://d.uy' },
        transportista: { conectado: true, cual: 'DAC', dacUsername: '12345678', correoUser: null },
      },
      5,
    );
    expect(html).toContain('Inmediato');
    expect(html).toContain('Cada hora');
    expect(html).toContain('el aviso instantáneo no está disponible');
    expect(html).not.toContain('Horario personalizado');
  });

  it('paso 5 con cron heredado muestra "Horario personalizado"', () => {
    const html = render({ ...BASE, currentStep: 4, processingMode: 'personalizado', cronSchedule: '0 9 * * 1-5', transportista: { conectado: true, cual: 'DAC', dacUsername: 'u', correoUser: null } }, 5);
    expect(html).toContain('Horario personalizado (configurado por soporte)');
  });

  it('paso 6: envíos gratis, saldo real del holder y el aviso de saldo compartido cuando es menor', () => {
    const html = render(
      {
        ...BASE,
        currentStep: 4,
        store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
        transportista: { conectado: true, cual: 'DAC', dacUsername: '12345678', correoUser: null },
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
    const html = render({ ...BASE, currentStep: 4, emailVerified: false, transportista: { conectado: true, cual: 'DAC', dacUsername: 'u', correoUser: null } }, 6);
    expect(html).toContain('Confirmá tu email para activar la cuenta');
    expect(html).toContain('/verify-email?email=juana%40tienda.uy');
  });

  it('ya completo y vuelve desde Configuración: "Procesar ahora" en vez de activar, y link a Configuración', () => {
    const html = render(
      {
        ...BASE,
        currentStep: 6,
        onboardingComplete: true,
        isActive: true,
        store: { kind: 'shopify', shopifyConnected: true, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
        transportista: { conectado: true, cual: 'DAC', dacUsername: 'u', correoUser: null },
      },
      6,
    );
    expect(html).toContain('Procesar ahora');
    expect(html).not.toContain('Activar y procesar ahora');
    expect(html).toContain('Volver a Configuración');
  });

  it('ya completo pero desinstaló la app: abre en el paso 2, la tienda NO figura hecha y no ofrece volver a Configuración', () => {
    const html = render({
      ...BASE,
      currentStep: 2,
      onboardingComplete: true,
      isActive: true,
      store: { kind: null, shopifyConnected: false, shopifyStoreUrl: 'acme.myshopify.com', dashboardConnected: false, dashboardUrl: null },
      transportista: { conectado: true, cual: 'DAC', dacUsername: 'u', correoUser: null },
    });
    expect(html).toContain('Falta un dato para volver a procesar');
    expect(html).not.toContain('Volver a Configuración');
    expect(html).not.toContain('Vamos a dejar tus envíos');
    // En la barra, 5 de los 6 pasos llevan tilde: todos menos el 2 (activo,
    // tienda perdida). Si la tienda contara como hecha por `onboardingComplete`,
    // el usuario no vería qué le falta.
    const checks = (html.match(/lucide-check\b/g) ?? []).length;
    expect(checks).toBe(5);
  });

  it('el pie de confianza no usa el candado como emoji', () => {
    const html = render(BASE);
    expect(html).toContain('Tus credenciales se guardan cifradas (AES-256)');
    expect(html).not.toContain('🔒');
  });
});
