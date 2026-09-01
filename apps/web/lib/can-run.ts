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

export interface PlanLimitInput {
  /** Plan legacy de MercadoPago. `null` en todo cliente que llegó por packs. */
  stripePriceId: string | null;
  /** Etiquetas del mes de la tienda que origina la corrida. */
  labelsThisMonth: number;
}

export type RunGate =
  | { ok: true }
  | { ok: false; status: 403 | 429; message: string };

/** Saldo total de envíos del holder: comprados + bonificados. */
export function creditBalance(h: Pick<RunGateInput, 'shipmentCredits' | 'referralBonusCredits'>): number {
  return (h.shipmentCredits ?? 0) + (h.referralBonusCredits ?? 0);
}

export function checkRunGate(holder: RunGateInput): RunGate {
  if (!holder.isActive) {
    return {
      ok: false,
      status: 403,
      message: 'Tu cuenta está pausada. Escribinos para reactivarla.',
    };
  }

  const balance = creditBalance(holder);
  const legacySubscription = holder.subscriptionStatus === 'ACTIVE';

  if (balance <= 0 && !legacySubscription) {
    return {
      ok: false,
      status: 403,
      message: 'Te quedaste sin envíos. Comprá un pack para seguir despachando.',
    };
  }

  return { ok: true };
}

/**
 * Tope mensual de etiquetas por plan.
 *
 * POR QUÉ ESTO TAMBIÉN VIVE ACÁ
 * -----------------------------
 * Destrabar `checkRunGate` sin tocar esto no arregla nada: `getPlanLimit(null)`
 * devuelve 0 (`lib/mercadopago.ts:66`), y los tres disparos manuales hacen
 * `labelsThisMonth >= limit`. Para un cliente de packs —que tiene
 * `stripePriceId = null`, porque los únicos dos writers de ese campo son el
 * flujo legacy de suscripción de MercadoPago— eso es `0 >= 0`, o sea 429
 * "Alcanzaste el límite de 0 etiquetas". El cliente seguía sin poder despachar;
 * lo único que cambiaba era el número del error.
 *
 * Lo detectó la revisión adversarial del 2026-09-01 re-derivando las 72
 * combinaciones de (isActive × subscriptionStatus × saldo × stripePriceId).
 *
 * La regla correcta: el plan legacy topea por etiquetas; el modelo de packs
 * topea por SALDO, y el saldo ya lo verificó `checkRunGate`. Sin plan legacy,
 * no hay tope de etiquetas que aplicar.
 */
export function checkPlanLimit(
  input: PlanLimitInput,
  getLimit: (planId: string | null) => number,
): RunGate {
  // Cliente de packs: el límite es la billetera, no un plan que no tiene.
  if (!input.stripePriceId) return { ok: true };

  const limit = getLimit(input.stripePriceId);
  if (input.labelsThisMonth >= limit) {
    return {
      ok: false,
      status: 429,
      message: `Alcanzaste el límite de ${limit} etiquetas este mes. Mejorá tu plan para continuar.`,
    };
  }
  return { ok: true };
}
