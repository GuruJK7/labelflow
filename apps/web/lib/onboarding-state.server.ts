import { db } from '@/lib/db';
import { decryptOrRaw } from '@/lib/encryption';
import { getCreditHolderTenantId } from '@/lib/credit-holder';
import { TRIAL_SHIPMENTS } from '@/lib/trial';
import { deriveOnboarding, type OnboardingState } from '@/lib/onboarding-state';

/**
 * Arma el `OnboardingState` que ven el server component de /onboarding y
 * `GET /api/v1/onboarding/state`. Un solo lugar para que la página y el
 * refresco del wizard nunca difieran.
 *
 * Nunca devuelve tokens ni contraseñas: sólo booleanos de "está cargado" y
 * el usuario de DAC descifrado (misma regla que `GET /api/v1/settings`).
 * El saldo sale del tenant holder (multi-tienda: el wallet vive en el más
 * viejo del user), igual que en el layout del dashboard.
 */
export async function loadOnboardingState(tenantId: string): Promise<OnboardingState | null> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: {
      shopifyStoreUrl: true,
      shopifyToken: true,
      dashboardSourceEnabled: true,
      dashboardUrl: true,
      dashboardToken: true,
      dacUsername: true,
      dacPassword: true,
      // El alta se puede completar con DAC O con Correo Uruguayo.
      correoEnabled: true,
      correoUser: true,
      correoPassword: true,
      onboardingComplete: true,
      cronSchedule: true,
      isActive: true,
      paymentRuleEnabled: true,
      paymentThreshold: true,
      fulfillMode: true,
      skuInObservations: true,
      codEnabled: true,
      emailHost: true,
      emailUser: true,
      emailPass: true,
      allowedProductTypes: true,
      consolidateConsecutiveOrders: true,
      consolidationWindowMinutes: true,
      user: { select: { email: true, emailVerified: true } },
    },
  });
  if (!tenant) return null;

  const holderId = await getCreditHolderTenantId(tenantId);
  const [wallet, shippingRulesCount] = await Promise.all([
    db.tenant.findUnique({
      where: { id: holderId },
      select: { shipmentCredits: true, referralBonusCredits: true },
    }),
    db.shippingRule.count({ where: { tenantId, isActive: true } }),
  ]);

  const derived = deriveOnboarding(tenant);
  const shipmentCredits = wallet?.shipmentCredits ?? 0;
  const referralBonusCredits = wallet?.referralBonusCredits ?? 0;
  const fulfillMode = (['off', 'on', 'always'] as const).includes(tenant.fulfillMode as 'off')
    ? (tenant.fulfillMode as 'off' | 'on' | 'always')
    : 'on';
  const allowed = Array.isArray(tenant.allowedProductTypes)
    ? (tenant.allowedProductTypes as unknown[]).filter((x): x is string => typeof x === 'string')
    : null;

  return {
    currentStep: derived.currentStep,
    store: {
      kind: derived.store.kind,
      shopifyConnected: derived.store.shopify,
      shopifyStoreUrl: tenant.shopifyStoreUrl,
      dashboardConnected: derived.store.dashboard,
      dashboardUrl: tenant.dashboardUrl,
    },
    dac: { connected: derived.dac, username: derived.dac ? decryptOrRaw(tenant.dacUsername) : null },
    processingMode: derived.mode,
    cronSchedule: tenant.cronSchedule ?? '',
    onboardingComplete: derived.complete,
    isActive: tenant.isActive,
    emailVerified: !!tenant.user?.emailVerified,
    email: tenant.user?.email ?? null,
    trialShipments: TRIAL_SHIPMENTS,
    balance: {
      shipmentCredits,
      referralBonusCredits,
      total: shipmentCredits + referralBonusCredits,
    },
    params: {
      paymentRuleEnabled: tenant.paymentRuleEnabled,
      paymentThreshold: tenant.paymentThreshold,
      fulfillMode,
      skuInObservations: tenant.skuInObservations,
      codEnabled: tenant.codEnabled,
      // El worker sólo manda el aviso si hay host + usuario + contraseña.
      emailConfigured: !!tenant.emailHost && !!tenant.emailUser && !!tenant.emailPass,
      allowedProductTypes: allowed && allowed.length > 0 ? allowed : null,
      consolidateConsecutiveOrders: tenant.consolidateConsecutiveOrders,
      consolidationWindowMinutes: tenant.consolidationWindowMinutes,
      shippingRulesCount,
    },
  };
}
