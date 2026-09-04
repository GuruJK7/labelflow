import { describe, it, expect } from 'vitest';
import {
  storeConnection,
  hasDac,
  isConnected,
  processingModeFromCron,
  cronForMode,
  deriveOnboarding,
  parseRequestedStep,
  shouldRedirectToDashboard,
  ONBOARDING_STEPS,
  CRON_INMEDIATO,
  CRON_CADA_HORA,
  type OnboardingRow,
} from '../onboarding-state';

/**
 * Derivación del estado del onboarding (D33): una sola definición de
 * "tienda conectada" / "DAC cargado" / "modo" que comparten el gate del
 * dashboard, `complete`, `state` y `jobs`. Si esto se rompe, el usuario
 * rebota entre /dashboard y /onboarding.
 */
const VACIO: OnboardingRow = {
  shopifyStoreUrl: null,
  shopifyToken: null,
  dashboardSourceEnabled: false,
  dashboardUrl: null,
  dashboardToken: null,
  dacUsername: null,
  dacPassword: null,
  correoEnabled: false,
  correoUser: null,
  correoPassword: null,
  onboardingComplete: false,
  cronSchedule: null,
};
const SHOPIFY = { shopifyStoreUrl: 'acme.myshopify.com', shopifyToken: 'enc:tok' };
const DASHBOARD = { dashboardSourceEnabled: true, dashboardUrl: 'https://dash.uy', dashboardToken: 'enc:tok' };
const DAC = { dacUsername: 'enc:u', dacPassword: 'enc:p' };

describe('storeConnection', () => {
  it('sólo Shopify → shopify', () => {
    expect(storeConnection({ ...VACIO, ...SHOPIFY })).toEqual({ kind: 'shopify', shopify: true, dashboard: false });
  });
  it('sólo Dashboard con Excel → dashboard', () => {
    expect(storeConnection({ ...VACIO, ...DASHBOARD })).toEqual({ kind: 'dashboard', shopify: false, dashboard: true });
  });
  it('las dos → manda Shopify, pero dashboard sigue en true', () => {
    expect(storeConnection({ ...VACIO, ...SHOPIFY, ...DASHBOARD })).toEqual({ kind: 'shopify', shopify: true, dashboard: true });
  });
  it('dashboard con URL y token pero fuente apagada → null', () => {
    expect(storeConnection({ ...VACIO, ...DASHBOARD, dashboardSourceEnabled: false }).kind).toBeNull();
  });
  it('dashboard prendido con URL pero sin token → null', () => {
    expect(storeConnection({ ...VACIO, ...DASHBOARD, dashboardToken: null }).kind).toBeNull();
  });
  it('Shopify con dominio pero sin token → null (token borrado desde Configuración)', () => {
    expect(storeConnection({ ...VACIO, shopifyStoreUrl: 'acme.myshopify.com' }).kind).toBeNull();
  });
  it('cadena vacía cuenta como ausente', () => {
    expect(storeConnection({ ...VACIO, shopifyStoreUrl: '', shopifyToken: 'x' }).kind).toBeNull();
  });
});

describe('hasDac / isConnected', () => {
  it('exige usuario Y contraseña', () => {
    expect(hasDac(VACIO)).toBe(false);
    expect(hasDac({ dacUsername: 'u', dacPassword: null })).toBe(false);
    expect(hasDac(DAC)).toBe(true);
  });
  it('isConnected = tienda (cualquiera) + DAC', () => {
    expect(isConnected({ ...VACIO, ...SHOPIFY })).toBe(false);
    expect(isConnected({ ...VACIO, ...DAC })).toBe(false);
    expect(isConnected({ ...VACIO, ...SHOPIFY, ...DAC })).toBe(true);
    expect(isConnected({ ...VACIO, ...DASHBOARD, ...DAC })).toBe(true);
  });
});

describe('processingModeFromCron / cronForMode', () => {
  it('reconoce los dos modos del paso 5', () => {
    expect(processingModeFromCron('*/15 * * * *')).toBe('inmediato');
    expect(processingModeFromCron('0 * * * *')).toBe('cada_hora');
  });
  it('tolera espacios de más', () => {
    expect(processingModeFromCron('  0  *  * * *')).toBe('cada_hora');
  });
  it('cualquier otro cron (slots, "nunca", null) → personalizado', () => {
    expect(processingModeFromCron('0 0 31 2 *')).toBe('personalizado');
    expect(processingModeFromCron('0,30 9,14 * * 1-5')).toBe('personalizado');
    expect(processingModeFromCron(null)).toBe('personalizado');
    expect(processingModeFromCron(undefined)).toBe('personalizado');
    expect(processingModeFromCron('')).toBe('personalizado');
  });
  it('cronForMode devuelve exactamente lo que processingModeFromCron reconoce', () => {
    expect(cronForMode('inmediato')).toBe(CRON_INMEDIATO);
    expect(cronForMode('cada_hora')).toBe(CRON_CADA_HORA);
    expect(processingModeFromCron(cronForMode('inmediato'))).toBe('inmediato');
    expect(processingModeFromCron(cronForMode('cada_hora'))).toBe('cada_hora');
  });
  it('los dos crons pasan la validación de PUT /api/v1/settings (mínimo 15 min sólo para */N)', () => {
    const re = /^(\*|[0-9,\-\/*]+)\s+(\*|[0-9,\-\/*]+)\s+(\*|[0-9,\-\/*]+)\s+(\*|[0-9,\-\/*]+)\s+(\*|[0-9,\-\/*]+)$/;
    for (const c of [CRON_INMEDIATO, CRON_CADA_HORA]) {
      expect(re.test(c)).toBe(true);
      const [min] = c.split(' ');
      expect(min).not.toBe('*');
      if (min.startsWith('*/')) expect(parseInt(min.substring(2))).toBeGreaterThanOrEqual(15);
    }
  });
});

describe('deriveOnboarding', () => {
  it('nada → paso 1 (bienvenida)', () => {
    expect(deriveOnboarding(VACIO).currentStep).toBe(1);
  });
  it('sólo DAC → paso 2 (falta la tienda)', () => {
    expect(deriveOnboarding({ ...VACIO, ...DAC }).currentStep).toBe(2);
  });
  it('sólo tienda (Shopify o Dashboard) → paso 3 (falta DAC)', () => {
    expect(deriveOnboarding({ ...VACIO, ...SHOPIFY }).currentStep).toBe(3);
    expect(deriveOnboarding({ ...VACIO, ...DASHBOARD }).currentStep).toBe(3);
  });
  it('tienda + DAC → paso 4 (parámetros), aunque el cron sea raro', () => {
    const d = deriveOnboarding({ ...VACIO, ...DASHBOARD, ...DAC, cronSchedule: '0 0 31 2 *' });
    expect(d.currentStep).toBe(4);
    expect(d.mode).toBe('personalizado');
    expect(d.complete).toBe(false);
  });
  it('completo y conectado → paso 6', () => {
    const d = deriveOnboarding({ ...VACIO, ...SHOPIFY, ...DAC, onboardingComplete: true, cronSchedule: CRON_INMEDIATO });
    expect(d.currentStep).toBe(6);
    expect(d.complete).toBe(true);
    expect(d.mode).toBe('inmediato');
    expect(d.store.kind).toBe('shopify');
    expect(d.transportista).toBe(true);
  });
  it('completo pero desinstaló la app (shopifyToken null, como deja `uninstalled`) → paso 2, no 6', () => {
    // Si devolviera 6, la página mandaría al dashboard y el gate del dashboard
    // devolvería al wizard: ERR_TOO_MANY_REDIRECTS. Revisión 2026-09-02.
    const d = deriveOnboarding({ ...VACIO, ...SHOPIFY, ...DAC, onboardingComplete: true, shopifyToken: null });
    expect(d.currentStep).toBe(2);
    expect(d.complete).toBe(true);
    expect(d.store.kind).toBeNull();
  });
  it('completo pero borró DAC desde Configuración → paso 3', () => {
    expect(deriveOnboarding({ ...VACIO, ...SHOPIFY, onboardingComplete: true }).currentStep).toBe(3);
    expect(deriveOnboarding({ ...VACIO, ...DASHBOARD, dacUsername: 'u', dacPassword: null, onboardingComplete: true }).currentStep).toBe(3);
  });
  it('completo sin tienda ni DAC → paso 2 (la bienvenida no le aporta nada)', () => {
    expect(deriveOnboarding({ ...VACIO, onboardingComplete: true }).currentStep).toBe(2);
  });
});

describe('shouldRedirectToDashboard (regla de /onboarding)', () => {
  const ok = { onboardingComplete: true, store: { kind: 'shopify' as const, shopifyConnected: true, shopifyStoreUrl: 'a', dashboardConnected: false, dashboardUrl: null }, transportista: { conectado: true, cual: 'DAC', dacUsername: 'u', correoUser: null } };
  const sinParams = { requestedStep: null, shopifyReturn: false };
  it('completo y conectado, sin params → al dashboard', () => {
    expect(shouldRedirectToDashboard(ok, sinParams)).toBe(true);
  });
  it('completo pero sin tienda o sin DAC → se queda en el wizard (evita el loop con el gate del dashboard)', () => {
    expect(shouldRedirectToDashboard({ ...ok, store: { ...ok.store, kind: null, shopifyConnected: false } }, sinParams)).toBe(false);
    expect(shouldRedirectToDashboard({ ...ok, transportista: { conectado: false, cual: null, dacUsername: null, correoUser: null } }, sinParams)).toBe(false);
  });
  it('no completo → wizard', () => {
    expect(shouldRedirectToDashboard({ ...ok, onboardingComplete: false }, sinParams)).toBe(false);
  });
  it('?step=N o retorno del OAuth (?shopify=connected) → wizard aunque esté completo y conectado', () => {
    expect(shouldRedirectToDashboard(ok, { requestedStep: 4, shopifyReturn: false })).toBe(false);
    expect(shouldRedirectToDashboard(ok, { requestedStep: null, shopifyReturn: true })).toBe(false);
  });
});

describe('parseRequestedStep', () => {
  it('acepta 1–6 y nada más', () => {
    expect(parseRequestedStep('4')).toBe(4);
    expect(parseRequestedStep(['6'])).toBe(6);
    expect(parseRequestedStep('0')).toBeNull();
    expect(parseRequestedStep('7')).toBeNull();
    expect(parseRequestedStep('2.5')).toBeNull();
    expect(parseRequestedStep('abc')).toBeNull();
    expect(parseRequestedStep(undefined)).toBeNull();
  });
});

describe('ONBOARDING_STEPS', () => {
  it('son 6, numerados 1..6, con tiempo estimado en todos menos el último', () => {
    expect(ONBOARDING_STEPS.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const s of ONBOARDING_STEPS.slice(0, 5)) expect(s.estimate).not.toBe('');
    expect(ONBOARDING_STEPS[5].estimate).toBe('');
  });
});
