/**
 * ¿Este tenant puede disparar un procesamiento manual?
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 * ---------------------------
 * Hasta 2026-09-01 los disparos manuales (`POST /api/v1/jobs`,
 * `POST /api/v1/control/run`) exigían `subscriptionStatus === 'ACTIVE'`.
 * Ese campo lo escribe ÚNICAMENTE el flujo legacy de suscripción recurrente
 * de MercadoPago (`webhooks/mercadopago` preapproval). El modelo de cobro
 * vigente —packs de créditos, pago único vía Preference— nunca lo toca:
 * ni `credit-packs/checkout`, ni `onboarding/complete`, ni
 * `provisioning/dac-tenant` lo escriben.
 *
 * Resultado: todo cliente que llegó por packs quedaba con
 * `subscriptionStatus = 'INACTIVE'` (el default) para siempre, y el botón
 * "Ejecutar ahora" le devolvía 403 aunque tuviera saldo y estuviera activo.
 * El síntoma era desconcertante justamente porque el cron NO tiene este
 * problema — sólo mira `isActive` y saldo (`apps/worker/src/jobs/scheduler.ts`).
 * O sea: "se despacha solo, pero el botón dice que no tengo plan".
 *
 * La regla correcta es la misma que usa el scheduler, para que las dos vías
 * de disparo no puedan volver a divergir: está activo y tiene con qué pagar.
 * Se conserva `subscriptionStatus === 'ACTIVE'` como alternativa para no
 * romper a los clientes legacy que siguen con suscripción viva y saldo en 0.
 */

export interface RunGateInput {
  isActive: boolean;
  subscriptionStatus: string;
  shipmentCredits: number;
  referralBonusCredits: number;
}

export type RunGate =
  | { ok: true }
  | { ok: false; status: 403; message: string };

/** Saldo total de envíos del holder: comprados + bonificados. */
export function creditBalance(h: Pick<RunGateInput, 'shipmentCredits' | 'referralBonusCredits'>): number {
  return (h.shipmentCredits ?? 0) + (h.referralBonusCredits ?? 0);
}

export function checkRunGate(holder: RunGateInput): RunGate {
  if (!holder.isActive) {
    return {
      ok: false,
      status: 403,
      message: 'Tu cuenta esta pausada. Escribinos para reactivarla.',
    };
  }

  const balance = creditBalance(holder);
  const legacySubscription = holder.subscriptionStatus === 'ACTIVE';

  if (balance <= 0 && !legacySubscription) {
    return {
      ok: false,
      status: 403,
      message: 'Te quedaste sin envios. Compra un pack para seguir despachando.',
    };
  }

  return { ok: true };
}
