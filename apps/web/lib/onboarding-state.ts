/**
 * Estado del onboarding DERIVADO de la base, sin columnas nuevas (D33).
 *
 * Por qué derivado y no guardado: el wizard tiene 6 pasos pero la base ya
 * sabe todo lo que importa — si hay tienda (Shopify o Dashboard con Excel),
 * si hay cuenta de DAC, qué cron corre y si el usuario apretó "Activar".
 * Guardar "en qué paso va" duplicaría eso y se desincronizaría en cuanto
 * alguien borre un token desde Configuración. Acá vive la ÚNICA definición
 * de "tienda conectada" / "DAC cargado" y la usan el gate del dashboard,
 * `onboarding/complete`, `GET /api/v1/onboarding/state` y `POST /api/v1/jobs`.
 *
 * Es puro (sin Prisma, sin React) para que se testee en node y para que el
 * server component de /onboarding y las rutas compartan exactamente la misma
 * lógica.
 */

export interface OnboardingRow {
  shopifyStoreUrl: string | null;
  shopifyToken: string | null;
  dashboardSourceEnabled: boolean;
  dashboardUrl: string | null;
  dashboardToken: string | null;
  dacUsername: string | null;
  dacPassword: string | null;
  /** Transportista alternativo: Correo Uruguayo. Ver `hasCorreo`. */
  correoEnabled: boolean;
  correoUser: string | null;
  correoPassword: string | null;
  onboardingComplete: boolean;
  cronSchedule: string | null;
}

export type StoreKind = 'shopify' | 'dashboard' | null;

export interface StoreConnection {
  kind: StoreKind;
  shopify: boolean;
  dashboard: boolean;
}

/**
 * Tienda conectada = Shopify (dominio + token) O Dashboard con Excel
 * (fuente prendida + URL + token). Si hay las dos, manda Shopify: es la que
 * tiene aviso instantáneo y la que el worker procesa por la cola.
 */
export function storeConnection(
  r: Pick<OnboardingRow, 'shopifyStoreUrl' | 'shopifyToken' | 'dashboardSourceEnabled' | 'dashboardUrl' | 'dashboardToken'>,
): StoreConnection {
  const shopify = !!r.shopifyStoreUrl && !!r.shopifyToken;
  const dashboard = !!r.dashboardSourceEnabled && !!r.dashboardUrl && !!r.dashboardToken;
  return { kind: shopify ? 'shopify' : dashboard ? 'dashboard' : null, shopify, dashboard };
}

export function hasDac(r: Pick<OnboardingRow, 'dacUsername' | 'dacPassword'>): boolean {
  return !!r.dacUsername && !!r.dacPassword;
}

/**
 * Correo Uruguayo cargado y elegido como transportista.
 *
 * Se exige `correoEnabled` además de las credenciales: tener usuario y clave
 * guardados pero el interruptor apagado significa que la tienda despacha por
 * DAC, no por Correo.
 */
export function hasCorreo(
  r: Pick<OnboardingRow, 'correoEnabled' | 'correoUser' | 'correoPassword'>,
): boolean {
  return !!r.correoEnabled && !!r.correoUser && !!r.correoPassword;
}

/**
 * ¿La tienda tiene CON QUÉ despachar?
 *
 * 🔴 Antes esto era `hasDac` a secas, y era correcto mientras DAC fuera el
 * único transportista. Desde que se puede elegir Correo Uruguayo, exigir DAC
 * dejaba a una tienda que eligió Correo sin poder terminar el alta nunca:
 * `onboardingComplete` no se sellaba, `isActive` quedaba en false y no
 * despachaba un solo pedido, sin ningún mensaje que explicara por qué.
 */
export function hasTransportista(
  r: Pick<OnboardingRow, 'dacUsername' | 'dacPassword' | 'correoEnabled' | 'correoUser' | 'correoPassword'>,
): boolean {
  return hasDac(r) || hasCorreo(r);
}

/** Regla del gate del dashboard: sin esto, al wizard. */
export function isConnected(r: OnboardingRow): boolean {
  return storeConnection(r).kind !== null && hasTransportista(r);
}

/* ─── Modo de procesamiento (paso 5) sobre `cronSchedule` (H8) ─────────── */

/** Inmediato: webhook `orders/paid` cuando existe + barrido cada 15 min. */
export const CRON_INMEDIATO = '*/15 * * * *';
/** Cada hora: en punto (10:00, 11:00, 12:00…), en la zona horaria del tenant. */
export const CRON_CADA_HORA = '0 * * * *';

export type ProcessingMode = 'inmediato' | 'cada_hora' | 'personalizado';

export function processingModeFromCron(cron: string | null | undefined): ProcessingMode {
  const c = (cron ?? '').trim().replace(/\s+/g, ' ');
  if (c === CRON_INMEDIATO) return 'inmediato';
  if (c === CRON_CADA_HORA) return 'cada_hora';
  return 'personalizado';
}

export function cronForMode(mode: 'inmediato' | 'cada_hora'): string {
  return mode === 'inmediato' ? CRON_INMEDIATO : CRON_CADA_HORA;
}

/* ─── Paso actual ──────────────────────────────────────────────────────── */

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface DerivedOnboarding {
  store: StoreConnection;
  /** Tiene con qué despachar: DAC o Correo Uruguayo. */
  transportista: boolean;
  mode: ProcessingMode;
  complete: boolean;
  currentStep: OnboardingStep;
}

/**
 * Paso al que hay que llevar al usuario cuando abre /onboarding:
 *   completo y conectado → 6
 *   ni tienda ni DAC     → 1 (bienvenida); si ya había completado, 2:
 *                          la bienvenida no le aporta nada, le falta la tienda
 *   sin tienda           → 2
 *   sin DAC              → 3
 *   tienda + DAC         → 4 (parámetros: no tiene estado propio, es revisión;
 *                             5 y 6 se alcanzan avanzando)
 *
 * Un tenant COMPLETO puede perder la tienda o DAC después (desinstaló la app
 * desde Shopify: `uninstalled` deja `shopifyToken = null`; borró un token
 * desde Configuración). El gate del dashboard lo manda al wizard, y el wizard
 * tiene que abrir en el paso roto, no en "Listo": si abriera en 6 y la página
 * lo devolviera al dashboard, quedaría rebotando (ERR_TOO_MANY_REDIRECTS).
 */
export function deriveOnboarding(r: OnboardingRow): DerivedOnboarding {
  const store = storeConnection(r);
  const transportista = hasTransportista(r);
  const mode = processingModeFromCron(r.cronSchedule);
  const complete = !!r.onboardingComplete;
  let currentStep: OnboardingStep;
  if (!store.kind) currentStep = complete || transportista ? 2 : 1;
  else if (!transportista) currentStep = 3;
  else currentStep = complete ? 6 : 4;
  return { store, transportista, mode, complete, currentStep };
}

/**
 * Regla de la página /onboarding para devolver al dashboard: sólo si completó
 * Y sigue conectado (tienda + DAC). Con un paso pedido (`?step=N`) o con el
 * retorno del OAuth (`?shopify=…`) nunca se redirige: el usuario vino a ver
 * algo del wizard.
 */
export function shouldRedirectToDashboard(
  state: Pick<OnboardingState, 'onboardingComplete' | 'store' | 'transportista'>,
  opts: { requestedStep: OnboardingStep | null; shopifyReturn: boolean },
): boolean {
  if (opts.requestedStep || opts.shopifyReturn) return false;
  return state.onboardingComplete && state.store.kind !== null && state.transportista.conectado;
}

/* ─── Metadatos de los pasos (título, tiempo estimado) ─────────────────── */

export interface OnboardingStepMeta {
  number: OnboardingStep;
  /** Título corto para la barra de progreso. */
  title: string;
  /** Tiempo estimado que ve el usuario; vacío en el último paso. */
  estimate: string;
  /** Una línea para el checklist de bienvenida. */
  summary: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepMeta[] = [
  { number: 1, title: 'Bienvenida', estimate: '2 min de lectura', summary: 'Qué vamos a configurar y cuánto tarda.' },
  { number: 2, title: 'Tu tienda', estimate: '2 min', summary: 'Shopify con un botón, o tu Dashboard con Excel.' },
  { number: 3, title: 'Transportista', estimate: '1 min', summary: 'Elegís DAC o Correo Uruguayo y cargás esa cuenta.' },
  { number: 4, title: 'Parámetros', estimate: '3 min', summary: 'Quién paga el envío, envío gratis, qué productos, aviso al cliente.' },
  { number: 5, title: 'Cada cuánto', estimate: '30 seg', summary: 'Al instante o una vez por hora.' },
  { number: 6, title: 'Listo', estimate: '', summary: 'Tus envíos de prueba y el primer procesamiento.' },
] as const;

/** `?step=N` de la URL → paso válido o null. Acepta sólo 1–6 enteros. */
export function parseRequestedStep(raw: string | string[] | null | undefined): OnboardingStep | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== 'string' || !/^[1-6]$/.test(s.trim())) return null;
  return Number(s.trim()) as OnboardingStep;
}

/* ─── Contrato de `GET /api/v1/onboarding/state` ───────────────────────── */

export interface OnboardingState {
  currentStep: OnboardingStep;
  store: {
    kind: StoreKind;
    shopifyConnected: boolean;
    shopifyStoreUrl: string | null;
    dashboardConnected: boolean;
    dashboardUrl: string | null;
  };
  /**
   * El transportista con el que la tienda va a despachar. `conectado` es lo que
   * habilita el paso 3 y el alta: se cumple con DAC O con Correo Uruguayo.
   * Antes esto se llamaba `dac` y era el único posible.
   */
  transportista: {
    conectado: boolean;
    cual: 'DAC' | 'CORREO' | null;
    dacUsername: string | null;
    correoUser: string | null;
  };
  processingMode: ProcessingMode;
  cronSchedule: string;
  onboardingComplete: boolean;
  isActive: boolean;
  emailVerified: boolean;
  email: string | null;
  trialShipments: number;
  balance: { shipmentCredits: number; referralBonusCredits: number; total: number };
  params: {
    paymentRuleEnabled: boolean;
    paymentThreshold: number;
    fulfillMode: 'off' | 'on' | 'always';
    skuInObservations: boolean;
    codEnabled: boolean;
    emailConfigured: boolean;
    allowedProductTypes: string[] | null;
    consolidateConsecutiveOrders: boolean;
    consolidationWindowMinutes: number;
    shippingRulesCount: number;
  };
}
