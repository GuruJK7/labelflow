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
import { decrypt } from '@/lib/encryption';

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
    select: {
      id: true,
      shopifyStoreUrl: true,
      shopifyToken: true,
      codEnabled: true,
      dashboardSourceEnabled: true,
      dashboardUrl: true,
      dashboardToken: true,
    },
  });

  // ── Fuente dashboard (VentaFlow, y las cuentas que opera el depósito) ──────
  // Estas tiendas no tienen Shopify, así que hasta acá el panel mostraba un
  // guion para siempre. Para las cuentas del depósito eso es peor que un hueco
  // cosmético: como su cron está apagado a propósito, el ÚNICO disparo es el
  // botón "Ejecutar" de esta misma pantalla — y sin el número, apretarlo es
  // adivinar si hay algo para despachar.
  if (!tenant?.shopifyStoreUrl && tenant?.dashboardSourceEnabled && tenant.dashboardUrl && tenant.dashboardToken) {
    const contado = await contarEnDashboard(tenant.dashboardUrl, tenant.dashboardToken);
    if (contado === null) {
      return { tenantId, count: hit?.count ?? null, cached: false, skipped: 'error' };
    }
    cache.set(tenantId, { count: contado, at: Date.now() });
    return { tenantId, count: contado, cached: false };
  }

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

/** Cuántos pedidos entran como mucho en una corrida de la fuente dashboard. */
const TOPE_DASHBOARD = 250;

/**
 * Cuenta los pedidos listos de una tienda de la fuente dashboard, con la MISMA
 * llamada que hace el worker (`apps/worker/src/dashboard/orders.ts`): si esto
 * devuelve 12, una corrida trabaja sobre esos 12.
 *
 * Devuelve `null` ante cualquier problema — quien llama conserva el último
 * número bueno. Nunca tira: un dashboard caído no puede dejar sin pintar el
 * panel entero.
 *
 * 🔴 Defensa en profundidad sobre la URL, por el mismo motivo que el allowlist
 * de `*.myshopify.com` de arriba: `dashboardUrl` lo escriben dos caminos
 * (`onboarding/test-dashboard` y `provisioning/dac-tenant`) y sólo el primero
 * valida el host. Exigir https y descartar los destinos internos ACÁ significa
 * que ningún camino de escritura futuro puede convertir esta función en un
 * SSRF. El worker corre en Render con su propia red; esto corre en Vercel.
 */
async function contarEnDashboard(baseUrl: string, tokenCifrado: string): Promise<number | null> {
  let url: URL;
  try {
    url = new URL(baseUrl.replace(/\/+$/, '') + '/api/v1/orders');
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(':')
  ) {
    return null;
  }

  let token: string;
  try {
    token = decrypt(tokenCifrado);
  } catch {
    return null;
  }

  url.searchParams.set('status', 'confirmed');
  url.searchParams.set('limit', String(TOPE_DASHBOARD));
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { orders?: unknown[] };
    return Array.isArray(data?.orders) ? data.orders.length : null;
  } catch {
    return null;
  }
}
