/**
 * Live Shopify "pendientes" backlog count per store — the "pedidos para
 * completar" number on the multi-store control dashboard.
 *
 * Uses Shopify's cheap orders/count.json with the SAME filter the worker
 * processes (status=open, financial_status=paid, fulfillment_status=unfulfilled)
 * so the number reflects the true backlog a run would work through. One tiny
 * API call per store, THROTTLED via a process-local cache so a polling
 * dashboard cannot hammer Shopify / hit rate limits.
 *
 * This is an UPPER BOUND of what a run actually ships (the worker further skips
 * already-COMPLETED labels and C-4-blocked orders), so it is for display only —
 * the authoritative operational numbers (sin completar, hechos hoy/mes) come
 * from the DB in /api/v1/control/overview.
 */

import { db } from '@/lib/db';
import { shopifyAccessForTenant } from '@/lib/shopify-access';

const SHOPIFY_API_VERSION = '2024-01';
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min — a backlog number this stale is fine.

// Process-local cache: tenantId -> { count, at }. A serverless cold start just
// re-fetches; correctness never depends on the cache.
const cache = new Map<string, { count: number; at: number }>();

export interface PendingCount {
  tenantId: string;
  count: number | null; // null = could not fetch (no token / shopify error)
  cached: boolean;
  skipped?: 'no-token' | 'decrypt-failed' | 'error';
}

/**
 * Returns the count of open, unfulfilled Shopify orders for a tenant: the paid
 * ones, plus the `pending` ones when the store charges on delivery (codEnabled).
 * Cached for CACHE_TTL_MS unless `force`. Never throws — a Shopify hiccup
 * yields { count: <last cached or null> } so the dashboard keeps rendering.
 */
export async function getUnfulfilledCount(tenantId: string, force = false): Promise<PendingCount> {
  const hit = cache.get(tenantId);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { tenantId, count: hit.count, cached: true };
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true, codEnabled: true },
  });
  if (!tenant?.shopifyStoreUrl || !tenant.shopifyToken) {
    return { tenantId, count: null, cached: false, skipped: 'no-token' };
  }

  // Renueva bajo demanda si es un token del App Store (D29); legacy → mismo
  // string que `decrypt`. null cubre "no descifra" y "no se pudo renovar".
  const token = await shopifyAccessForTenant(tenant);
  if (!token) return { tenantId, count: null, cached: false, skipped: 'decrypt-failed' };

  // Defense-in-depth: only ever fetch a *.myshopify.com host. The write paths
  // (settings/onboarding) already enforce this allowlist, but asserting it at
  // the call site means no future write path can turn this into an SSRF.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(tenant.shopifyStoreUrl)) {
    return { tenantId, count: null, cached: false, skipped: 'error' };
  }

  try {
    // Una tienda que COBRA AL ENTREGAR tiene sus pedidos en `pending`, no en
    // `paid`: contando sólo los pagados el panel le mostraba 0 pendientes
    // mientras el worker despachaba. Se cuentan los dos estados y se suman.
    //
    // Son dos llamadas y no una con `financial_status=any` porque `count.json`
    // devuelve un número pelado: con `any` entrarían los reembolsados y
    // anulados y no habría forma de descontarlos. El worker descarta esos
    // mismos estados (ver ESTADOS_DESPACHABLES_CONTRAENTREGA), así que este
    // número y el que despacha el worker coinciden.
    const estados = tenant.codEnabled ? ['paid', 'pending'] : ['paid'];
    let count = 0;
    for (const financial of estados) {
      const params = new URLSearchParams({
        status: 'open',
        financial_status: financial,
        fulfillment_status: 'unfulfilled',
      });
      const url = `https://${tenant.shopifyStoreUrl}/admin/api/${SHOPIFY_API_VERSION}/orders/count.json?${params}`;
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!res.ok) {
        // Keep the last good number if we have one; otherwise signal the error.
        return { tenantId, count: hit?.count ?? null, cached: false, skipped: 'error' };
      }
      const data = (await res.json()) as { count?: number };
      count += typeof data.count === 'number' ? data.count : 0;
    }
    cache.set(tenantId, { count, at: Date.now() });
    return { tenantId, count, cached: false };
  } catch {
    return { tenantId, count: hit?.count ?? null, cached: false, skipped: 'error' };
  }
}
