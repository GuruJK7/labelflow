import crypto from 'crypto';

/**
 * Whop — segundo riel de cobro de packs (D30/D34). Dos piezas puras:
 *
 *   - `getWhopCheckoutUrls()`: lee `WHOP_CHECKOUT_URLS` (JSON `{packId: url}`)
 *     server-side. Las URLs nunca viajan al cliente: la UI sólo recibe la
 *     lista de ids con link, y el redirect lo hace `/api/credit-packs/whop-checkout`.
 *   - `verifyStandardWebhookSignature()`: Standard Webhooks
 *     (https://www.standardwebhooks.com/): HMAC-SHA256 en base64 sobre
 *     `${webhook-id}.${webhook-timestamp}.${cuerpo crudo}`, header
 *     `webhook-signature` con una o más firmas `v1,<base64>` separadas por
 *     espacio, tolerancia de 5 minutos. El secret puede venir con prefijo
 *     `whsec_` (base64) o plano.
 */

export const WHOP_SIGNATURE_TOLERANCE_SECONDS = 300;

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

/** Sólo para tests: permite volver a emitir el aviso de JSON inválido. */
export function _resetWhopWarnings(): void {
  warnedInvalidJson = false;
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
