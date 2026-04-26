import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { decryptIfPresent } from '@/lib/encryption';

/**
 * Cache entry for one Shopify product. Persisted as `Tenant.productTypeCache`.
 *
 * The worker filter (apps/worker/src/rules/product-filter.ts) matches the
 * tenant's `allowedProductTypes` whitelist against `title`, `type`, AND
 * `vendor`, case-insensitively. So the user can pick a granular product
 * (by title), a category (by type), or a brand (by vendor) — all from
 * the same chip UI.
 *
 * Legacy entries in the DB may still be plain strings (vendor name from
 * pre-2026-04-24 scans). The worker accepts both shapes; the next scan
 * upgrades them to this object shape.
 */
type ProductEntry = {
  title: string;
  type: string;
  vendor: string;
};

type ProductMap = Record<string, ProductEntry>;

/**
 * POST /api/v1/products/scan
 * Scans Shopify and rebuilds the product map.
 * Strategy 1: Products API (needs read_products scope) — title + product_type + vendor.
 * Strategy 2: Orders API fallback (no scope needed) — title from line_items.
 */
export async function POST() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify no configurado. Ve a Configuracion para conectar tu tienda.', 400);
  }

  const token = decryptIfPresent(tenant.shopifyToken);
  if (!token) return apiError('Token de Shopify invalido', 400);

  const baseUrl = `https://${tenant.shopifyStoreUrl}/admin/api/2024-01`;
  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  };

  try {
    let map: ProductMap = {};
    let source: 'products' | 'orders' = 'products';

    // ── Strategy 1: Products API ──
    const productsOk = await tryProductsApi(baseUrl, headers, map);

    // ── Strategy 2: Orders API fallback ──
    if (!productsOk) {
      source = 'orders';
      map = {};
      await tryOrdersApi(baseUrl, headers, map);
    }

    if (Object.keys(map).length === 0) {
      return apiError('No se encontraron productos en Shopify. Verifica que tu tienda tenga productos publicados.', 404);
    }

    // Persist enriched map. (Json column — no migration needed.)
    await db.tenant.update({
      where: { id: auth.tenantId },
      data: { productTypeCache: map },
    });

    return apiSuccess({
      ...summarize(map),
      source,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[products/scan] error:', (err as Error).message, (err as Error).stack);
    return apiError('Error escaneando productos', 500);
  }
}

/**
 * GET /api/v1/products/scan
 * Returns cached product map and current filter without calling Shopify.
 */
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { productTypeCache: true, allowedProductTypes: true },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  const map = normalizeCache(tenant.productTypeCache);

  return apiSuccess({
    ...summarize(map),
    allowedProductTypes: (tenant.allowedProductTypes as string[] | null) ?? [],
  });
}

/**
 * Builds the response payload from a (normalized) product map.
 * - `products`: one entry per Shopify product, sorted by title. Used by the
 *   dashboard chip filter so users can pick individual products.
 * - `productTypes`: legacy field kept for the old chip UI — list of unique
 *   non-empty product_type values, sorted.
 * - `vendors`: unique non-empty vendor values, sorted. (Some stores leave
 *   product_type blank but use vendor as the de-facto category.)
 */
function summarize(map: ProductMap) {
  const products = Object.entries(map)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));

  const productTypes = uniqueSorted(Object.values(map).map((p) => p.type));
  const vendors = uniqueSorted(Object.values(map).map((p) => p.vendor));

  return {
    products,
    productTypes,
    vendors,
    totalProducts: products.length,
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].sort(
    (a, b) => a.localeCompare(b, 'es'),
  );
}

/**
 * Coerces both legacy (string) and current (object) cache entries into the
 * enriched ProductEntry shape so callers always get a consistent view.
 */
function normalizeCache(raw: unknown): ProductMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: ProductMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      // Legacy entry — vendor stored as a bare string. Stash it in `vendor`
      // (matches the worker's old fallback) and surface as the title too so
      // the chip UI has something to display until the next scan upgrades it.
      out[id] = { title: value, type: '', vendor: value };
    } else if (value && typeof value === 'object') {
      const v = value as Partial<ProductEntry>;
      out[id] = {
        title: typeof v.title === 'string' ? v.title : '',
        type: typeof v.type === 'string' ? v.type : '',
        vendor: typeof v.vendor === 'string' ? v.vendor : '',
      };
    }
  }
  return out;
}

/**
 * Try fetching products from the Products API.
 * Returns true if successful, false if access denied or failed.
 */
async function tryProductsApi(
  baseUrl: string,
  headers: Record<string, string>,
  map: ProductMap,
): Promise<boolean> {
  try {
    let url: string | null = `${baseUrl}/products.json?fields=id,product_type,title,vendor&limit=250`;

    while (url) {
      const res = await fetch(url, { headers });

      if (res.status === 403 || res.status === 401) {
        // Scope read_products not available — fall back
        return false;
      }
      if (!res.ok) return false;

      const data = await res.json();
      const products: Array<{ id: number; product_type: string; title: string; vendor: string }> =
        data.products ?? [];

      if (products.length === 0 && Object.keys(map).length === 0) return false;

      for (const product of products) {
        map[String(product.id)] = {
          title: (product.title || '').trim(),
          type: (product.product_type || '').trim(),
          vendor: (product.vendor || '').trim(),
        };
      }

      url = parsePaginationNext(res.headers.get('link'), baseUrl);
    }

    return Object.keys(map).length > 0;
  } catch {
    return false;
  }
}

/**
 * Fallback: extract products from recent orders' line_items.
 * Orders API doesn't expose product_type or vendor reliably, so we only
 * get title here. The worker matcher still works because it ORs across
 * title/type/vendor.
 */
async function tryOrdersApi(
  baseUrl: string,
  headers: Record<string, string>,
  map: ProductMap,
): Promise<void> {
  // Last 250 orders — good sample without over-fetching.
  const url = `${baseUrl}/orders.json?limit=250&status=any`;
  const res = await fetch(url, { headers });
  if (!res.ok) return;

  const data = await res.json();
  const orders: Array<{
    line_items: Array<{ product_id: number; title: string; vendor?: string }>;
  }> = data.orders ?? [];

  for (const order of orders) {
    for (const item of order.line_items ?? []) {
      if (!item.product_id) continue;
      const key = String(item.product_id);
      if (map[key]) continue; // First sighting wins.
      map[key] = {
        title: (item.title || '').trim(),
        type: '',
        vendor: (item.vendor || '').trim(),
      };
    }
  }
}

/**
 * Extrae la URL `rel="next"` del header Link de Shopify, validando que
 * apunte al MISMO origin de la tienda. Sin este check, una respuesta
 * maliciosa (Shopify comprometido, MITM, proxy roto) podría redirigir
 * nuestros fetch outbound a IMDS interno, Redis, o la API de Supabase
 * (SSRF). Cualquier URL fuera del baseUrl esperado se descarta.
 */
function parsePaginationNext(linkHeader: string | null, baseUrl: string): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) continue;
    const candidate = match[1];
    if (!candidate.startsWith(`${baseUrl}/`)) {
      console.warn(
        `[Shopify pagination] dropping next URL outside baseUrl: ${candidate}`,
      );
      return null;
    }
    return candidate;
  }
  return null;
}
