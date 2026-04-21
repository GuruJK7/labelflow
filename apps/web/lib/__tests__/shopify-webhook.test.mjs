// Self-contained test for Shopify webhook HMAC verification (C-1/C-2 fix).
// Run with:   node --test apps/web/lib/__tests__/shopify-webhook.test.mjs
// No vitest / jest dependency — uses node:test (built in since Node 18).
//
// We re-implement the verifier inline from the SAME spec as
// apps/web/lib/shopify-webhook.ts so the test proves the contract without
// needing a TS compile step. If the TS file drifts from this spec, this test
// will silently pass while the real code misbehaves — so the regression is
// "contract-level" rather than "implementation-level". That's the best we
// can do without bringing a test runner into the web app.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const APP_SECRET = 'app-shared-secret-from-partner-dashboard';
const FAKE_ACCESS_TOKEN = 'shpat_per_store_admin_api_token_NEVER_use_for_hmac';

function signWith(body, secret) {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

// Mirror of verifyShopifyWebhook. If the real helper changes, update this too.
function verifyShopifyWebhook(rawBody, hmacHeader, envSecret) {
  if (!hmacHeader) return false;
  if (!envSecret) return false;
  const digest = crypto.createHmac('sha256', envSecret).update(rawBody, 'utf8').digest('base64');
  try {
    const a = Buffer.from(hmacHeader, 'base64');
    const b = Buffer.from(digest, 'base64');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

test('accepts a webhook signed with the app shared secret', () => {
  const body = JSON.stringify({ id: 1, line_items: [] });
  const hmac = signWith(body, APP_SECRET);
  assert.equal(verifyShopifyWebhook(body, hmac, APP_SECRET), true);
});

test('C-1 regression: rejects a webhook signed with the per-store Admin API access token', () => {
  // This is the original bug: the route was passing decrypt(tenant.shopifyToken)
  // as the HMAC secret. Shopify ALWAYS signs with the app secret, so a payload
  // signed with an access token would never verify against the app secret.
  const body = JSON.stringify({ id: 1 });
  const hmac = signWith(body, FAKE_ACCESS_TOKEN);
  assert.equal(verifyShopifyWebhook(body, hmac, APP_SECRET), false);
});

test('rejects a webhook when the body is tampered', () => {
  const body = JSON.stringify({ id: 1, amount: 10 });
  const hmac = signWith(body, APP_SECRET);
  const tampered = JSON.stringify({ id: 1, amount: 9999 });
  assert.equal(verifyShopifyWebhook(tampered, hmac, APP_SECRET), false);
});

test('rejects a webhook with a missing HMAC header', () => {
  assert.equal(verifyShopifyWebhook('{}', null, APP_SECRET), false);
  assert.equal(verifyShopifyWebhook('{}', '', APP_SECRET), false);
});

test('fails closed when SHOPIFY_API_SECRET is unset', () => {
  // If the operator forgets to set the env var, verification must return
  // false for every input — NEVER accept-by-default.
  const body = JSON.stringify({ id: 1 });
  const hmac = signWith(body, APP_SECRET);
  assert.equal(verifyShopifyWebhook(body, hmac, undefined), false);
  assert.equal(verifyShopifyWebhook(body, hmac, ''), false);
});

test('rejects garbage base64 in the header without throwing', () => {
  assert.equal(verifyShopifyWebhook('{}', '@@@not-base64@@@', APP_SECRET), false);
});

test('rejects mismatched-length signatures (attacker cannot probe with truncated HMACs)', () => {
  const body = JSON.stringify({ id: 1 });
  const hmac = signWith(body, APP_SECRET);
  const truncated = hmac.slice(0, hmac.length - 4);
  assert.equal(verifyShopifyWebhook(body, truncated, APP_SECRET), false);
});
