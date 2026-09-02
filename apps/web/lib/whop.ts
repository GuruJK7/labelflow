import crypto from 'crypto';

/**
 * Whop — segundo riel de cobro de packs (D30/D34). Dos piezas puras:
 *
 *   - `getWhopCheckoutUrls()`: lee `WHOP_CHECKOUT_URLS` (JSON `{packId: url}`)
 *     server-side. Las URLs nunca viajan al cliente: la UI sólo recibe la
 *     lista de ids con link, y el redirect lo hace `/api/credit-packs/whop-checkout`.
 *   - `getWhopPlanRules()`: lee `WHOP_PLAN_IDS` (JSON `{packId: plan_id}` o
 *     `{packId: {planId, minUsd}}`). Es la defensa sobre el PRODUCTO: los links
 *     de checkout de Whop son públicos, así que un pago sólo acredita el pack de
 *     la compra PENDING si el plan que Whop dice que se pagó es el de ESE pack
 *     (`checkWhopPlanForPack`). Sin la var no se acredita nada (fail-closed).
 *   - `verifyStandardWebhookSignature()`: Standard Webhooks
 *     (https://www.standardwebhooks.com/): HMAC-SHA256 en base64 sobre
 *     `${webhook-id}.${webhook-timestamp}.${cuerpo crudo}`, header
 *     `webhook-signature` con una o más firmas `v1,<base64>` separadas por
 *     espacio, tolerancia de 5 minutos. El secret puede venir con prefijo
 *     `whsec_` (base64) o plano.
 */

export const WHOP_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Ventana en la que un segundo clic en "Pagar con Whop" reutiliza la compra
 * PENDING anterior del mismo usuario y pack en vez de crear otra (revisión
 * 2026-09-02): el webhook exige UNA sola PENDING reciente para acreditar.
 * Vive acá y no en la ruta porque Next no permite exportar constantes desde
 * un `route.ts`.
 */
export const WHOP_PENDING_REUSE_MINUTES = 30;

let warnedInvalidJson = false;

export function getWhopCheckoutUrls(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.WHOP_CHECKOUT_URLS;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('no es un objeto');
    const out: Record<string, string> = {};
    for (const [packId, url] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof url === 'string' && /^https:\/\//.test(url)) out[packId] = url;
    }
    return out;
  } catch (err) {
    if (!warnedInvalidJson) {
      warnedInvalidJson = true;
      console.error('[whop] WHOP_CHECKOUT_URLS no es JSON válido — botones de Whop ocultos:', (err as Error).message);
    }
    return {};
  }
}

export interface WhopPlanRule {
  /** id del plan (o del producto) de Whop, tal cual llega en el payload del pago. */
  planId: string;
  /** Piso en USD que Adrian fijó para ese plan; si está, el pago tiene que ser ≥ y en USD. */
  minUsd?: number;
}

let warnedInvalidPlanJson = false;

export function getWhopPlanRules(env: NodeJS.ProcessEnv = process.env): Record<string, WhopPlanRule> {
  const raw = env.WHOP_PLAN_IDS;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('no es un objeto');
    const out: Record<string, WhopPlanRule> = {};
    for (const [packId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) {
        out[packId] = { planId: value.trim() };
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const v = value as Record<string, unknown>;
        const planId = typeof v.planId === 'string' && v.planId.trim() ? v.planId.trim() : null;
        if (!planId) continue;
        const rule: WhopPlanRule = { planId };
        if (typeof v.minUsd === 'number' && Number.isFinite(v.minUsd) && v.minUsd > 0) rule.minUsd = v.minUsd;
        out[packId] = rule;
      }
    }
    return out;
  } catch (err) {
    if (!warnedInvalidPlanJson) {
      warnedInvalidPlanJson = true;
      console.error('[whop] WHOP_PLAN_IDS no es JSON válido — ningún pago se acredita:', (err as Error).message);
    }
    return {};
  }
}

export type PlanCheckFailure =
  | 'no_rules'
  | 'pack_not_mapped'
  | 'plan_missing'
  | 'plan_mismatch'
  | 'amount_missing'
  | 'currency_mismatch'
  | 'amount_below_min';

/**
 * ¿El pago que informa Whop corresponde al pack de la compra? Fail-closed en
 * cada rama: sin reglas, pack sin regla, payload sin plan, plan distinto, y
 * (si la regla trae `minUsd`) monto ausente, moneda que no es USD o monto
 * menor al piso. `payloadPlanIds` son TODOS los ids de plan/producto que
 * trae el evento: alcanza con que el configurado sea uno de ellos.
 */
export function checkWhopPlanForPack(input: {
  packId: string;
  payloadPlanIds: string[];
  amount: number | null;
  currency: string | null;
  rules: Record<string, WhopPlanRule>;
}): { ok: true } | { ok: false; reason: PlanCheckFailure } {
  const { packId, payloadPlanIds, amount, currency, rules } = input;
  if (Object.keys(rules).length === 0) return { ok: false, reason: 'no_rules' };
  const rule = rules[packId];
  if (!rule) return { ok: false, reason: 'pack_not_mapped' };
  if (payloadPlanIds.length === 0) return { ok: false, reason: 'plan_missing' };
  if (!payloadPlanIds.includes(rule.planId)) return { ok: false, reason: 'plan_mismatch' };
  if (rule.minUsd !== undefined) {
    if (amount === null || !Number.isFinite(amount)) return { ok: false, reason: 'amount_missing' };
    if (!currency || currency.trim().toLowerCase() !== 'usd') return { ok: false, reason: 'currency_mismatch' };
    if (amount < rule.minUsd) return { ok: false, reason: 'amount_below_min' };
  }
  return { ok: true };
}

/** Sólo para tests: permite volver a emitir los avisos de JSON inválido. */
export function _resetWhopWarnings(): void {
  warnedInvalidJson = false;
  warnedInvalidPlanJson = false;
}

export function whopSigningKey(secret: string): Buffer {
  return secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
}

/** Firma un cuerpo como lo haría Whop. Se exporta para los tests. */
export function signStandardWebhook(
  secret: string,
  webhookId: string,
  timestamp: string | number,
  rawBody: string,
): string {
  return crypto
    .createHmac('sha256', whopSigningKey(secret))
    .update(`${webhookId}.${timestamp}.${rawBody}`, 'utf8')
    .digest('base64');
}

export type SignatureFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_match';

export function verifyStandardWebhookSignature(input: {
  secret: string;
  webhookId: string | null;
  timestamp: string | null;
  signatureHeader: string | null;
  rawBody: string;
  nowMs?: number;
}): { ok: true } | { ok: false; reason: SignatureFailure } {
  const { secret, webhookId, timestamp, signatureHeader, rawBody } = input;
  if (!webhookId || !timestamp || !signatureHeader) return { ok: false, reason: 'missing_headers' };

  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  const ts = Number(timestamp);
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - ts) > WHOP_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = Buffer.from(signStandardWebhook(secret, webhookId, timestamp, rawBody), 'base64');

  for (const part of signatureHeader.split(/\s+/)) {
    if (!part) continue;
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(sig, 'base64');
    } catch {
      continue;
    }
    if (candidate.length !== expected.length) continue;
    if (crypto.timingSafeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: 'no_match' };
}
