import crypto from 'crypto';

/**
 * Shopify webhook HMAC verification.
 *
 * C-1/C-2 (2026-04-21 audit):
 *  - C-1: Previously HMAC was verified against `decrypt(tenant.shopifyToken)` (the
 *    per-shop Admin API access token). Shopify signs webhooks with the **app
 *    shared secret** (Partner dashboard → App credentials → "Client secret"),
 *    not with per-store access tokens, so every legitimate webhook was being
 *    rejected with "Invalid signature" (or worse: an attacker who obtained any
 *    access token could forge webhooks for that shop).
 *  - C-2: Verification ran AFTER a DB lookup by `x-shopify-shop-domain`. An
 *    unauthenticated attacker could enumerate which domains were tenants by
 *    timing/response differences. The fix verifies HMAC FIRST using only the
 *    request body + the header, then looks up the tenant only when the
 *    signature is valid.
 *
 * The secret is read from `SHOPIFY_API_SECRET`. Keep it in Vercel env.
 */

/**
 * Constant-time compare of two base64-encoded HMAC strings. Returns false on
 * any decoding error or length mismatch (length mismatch itself is NOT a
 * timing leak here: the secret is fixed-length and the header is attacker-
 * controlled, so a mismatched length just means "invalid").
 */
function constantTimeEqualB64(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, 'base64');
    const bBuf = Buffer.from(b, 'base64');
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * Verifies a Shopify webhook HMAC signature against the shared app secret.
 *
 * @param rawBody  The raw request body — MUST be the exact bytes Shopify signed.
 *                 Use `await req.text()` BEFORE any JSON.parse / transformation.
 * @param hmacHeader  Contents of the `x-shopify-hmac-sha256` header.
 * @returns true iff HMAC is valid AND the secret is configured.
 */
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null): boolean {
  if (!hmacHeader) return false;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    // Fail closed: if the operator forgot to set the env var, reject every
    // webhook rather than silently accepting everything (or accepting based on
    // some fallback). Log on the caller side; we return false here.
    return false;
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  return constantTimeEqualB64(hmacHeader, digest);
}
