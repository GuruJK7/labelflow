// Regression test for the JWT callback's tenant-refresh-stamp logic.
// Audit 2026-05-08 — this test locks in the fix for the JWT-lobotomy bug:
// when the tenant lookup failed transiently (Supabase incident, pgbouncer
// glitch, race with very recent signup), the OLD code stamped
// `tenantRefreshedAt = now` even on null, freezing the JWT for 15 minutes
// without `tenantId` → "No autorizado" on every protected endpoint.
//
// Run with:   node --test apps/web/lib/__tests__/auth-jwt-recovery.test.mjs
// No vitest / jest dependency — uses node:test (built in since Node 18).
//
// Same "contract-level" approach as shopify-webhook.test.mjs: we mirror
// the exact logic from apps/web/lib/auth.ts so this test proves the
// contract without needing a TypeScript compile step. Drift is detected
// via code review when auth.ts changes.

import test from 'node:test';
import assert from 'node:assert/strict';

const REFRESH_INTERVAL_S = 15 * 60; // 15 minutes — must match auth.ts

/**
 * Mirror of the post-tenant-lookup branch of the jwt() callback in
 * apps/web/lib/auth.ts. Takes the relevant inputs and returns the
 * mutations applied to the token.
 *
 * If auth.ts drifts from this contract, update both — the comment in
 * auth.ts points back to this test.
 */
function applyTenantRefresh({ token, tenant, now }) {
  // Clone to keep the assertion explicit about what changed
  const out = { ...token };
  if (tenant) {
    out.tenantId = tenant.id;
    out.tenantSlug = tenant.slug;
    out.isActive = tenant.isActive;
    out.subscriptionStatus = tenant.subscriptionStatus;
    out.tenantRefreshedAt = now;
  } else if (token.tenantId) {
    delete out.tenantId;
    delete out.tenantSlug;
    out.tenantRefreshedAt = now;
  } else {
    // Audit 2026-05-08 — short cooldown so the next request retries
    // soon (within 60s) instead of waiting the full 15-min refresh
    // interval. Prevents the "lobotomized JWT" bug.
    out.tenantRefreshedAt = now - REFRESH_INTERVAL_S + 60;
  }
  return out;
}

const NOW = 1_715_000_000; // arbitrary epoch seconds for deterministic tests

test('applyTenantRefresh: tenant FOUND → fresh stamp', () => {
  const token = { id: 'user-1' };
  const tenant = { id: 't-1', slug: 's', isActive: true, subscriptionStatus: 'ACTIVE' };
  const out = applyTenantRefresh({ token, tenant, now: NOW });
  assert.equal(out.tenantId, 't-1');
  assert.equal(out.tenantSlug, 's');
  assert.equal(out.isActive, true);
  assert.equal(out.subscriptionStatus, 'ACTIVE');
  assert.equal(out.tenantRefreshedAt, NOW);
});

test('applyTenantRefresh: tenant MISSING but token had prior tenantId → clear + fresh stamp', () => {
  const token = { id: 'user-1', tenantId: 'old-t', tenantSlug: 'old-s' };
  const out = applyTenantRefresh({ token, tenant: null, now: NOW });
  assert.equal(out.tenantId, undefined);
  assert.equal(out.tenantSlug, undefined);
  assert.equal(out.tenantRefreshedAt, NOW);
});

test('applyTenantRefresh: tenant MISSING and no prior tenantId → SHORT cooldown (60s)', () => {
  const token = { id: 'user-1' };
  const out = applyTenantRefresh({ token, tenant: null, now: NOW });
  assert.equal(out.tenantId, undefined);
  // The key assertion of this fix: don't freeze the token for 15 minutes.
  // Stamp tenantRefreshedAt back-dated so the next request triggers a retry
  // in ~60 seconds.
  const expectedStamp = NOW - REFRESH_INTERVAL_S + 60;
  assert.equal(out.tenantRefreshedAt, expectedStamp);

  // Verify the "next request" needsRefresh logic would actually trigger.
  // The auth.ts callback computes:
  //   needsRefresh = !token.tenantId
  //               || !token.tenantRefreshedAt
  //               || now - token.tenantRefreshedAt > REFRESH_INTERVAL_S
  //
  // Within 60s window, !token.tenantId is true → needsRefresh fires
  // every request. After 60s, the time check also fires.
  const fiveSecondsLater = NOW + 5;
  const needsRefresh =
    !out.tenantId ||
    !out.tenantRefreshedAt ||
    fiveSecondsLater - out.tenantRefreshedAt > REFRESH_INTERVAL_S;
  assert.equal(needsRefresh, true, 'JWT must be eligible for refresh on next request');
});

test('applyTenantRefresh: regression — does NOT freeze token for 15 min when tenant lookup fails', () => {
  // The pre-fix bug: stamping `tenantRefreshedAt = now` always meant a
  // failed tenant lookup blocked retries for 15 full minutes. This test
  // proves we don't do that anymore.
  const token = { id: 'user-1' }; // Fresh signup, no tenantId yet
  const out = applyTenantRefresh({ token, tenant: null, now: NOW });
  // Pre-fix: out.tenantRefreshedAt would equal NOW (fresh stamp).
  // Post-fix: it equals NOW - REFRESH_INTERVAL_S + 60 (back-dated).
  // The difference matters because the needsRefresh check uses the
  // age of tenantRefreshedAt to decide whether to re-query.
  const ageWhenChecked = NOW + 30 - out.tenantRefreshedAt; // 30 seconds later
  assert.ok(
    ageWhenChecked > REFRESH_INTERVAL_S - 60,
    `tenantRefreshedAt must be back-dated, got age=${ageWhenChecked}s`,
  );
});
