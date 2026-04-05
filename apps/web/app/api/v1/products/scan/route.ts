import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { decryptIfPresent } from '@/lib/encryption';

/**
 * POST /api/v1/products/scan
 * Scans Shopify to build a product_id→product_type map.
 * Strategy 1: Products API (needs read_products scope) — uses product_type field.
 * Strategy 2: Orders API fallback (always works) — extracts unique titles from line_items.
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
    let productTypeMap: Record<string, string> = {};
    let source: 'products' | 'orders' = 'products';

    // ── Strategy 1: Try Products API ──
    const productsOk = await tryProductsApi(baseUrl, headers, productTypeMap);

    // ── Strategy 2: Fallback to Orders API ──
    if (!productsOk) {
      source = 'orders';
      productTypeMap = {};
      await tryOrdersApi(baseUrl, headers, productTypeMap);
    }

    if (Object.keys(productTypeMap).length === 0) {
      return apiError('No se encontraron productos en Shopify. Verifica que tu tienda tenga productos publicados.', 404);
    }

    // Extract unique product types
    const uniqueTypes = [...new Set(Object.values(productTypeMap))].sort();

    // Save cache to tenant
    await db.tenant.update({
      where: { id: auth.tenantId },
      data: { productTypeCache: productTypeMap },
    });

    return apiSuccess({
      productTypes: uniqueTypes,
      totalProducts: Object.keys(productTypeMap).length,
      source,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    return apiError(`Error escaneando: ${(err as Error).message}`, 500);
  }
}

/**
 * Try fetching products from the Products API.
 * Returns true if successful, false if access denied or failed.
 */
async function tryProductsApi(
  baseUrl: string,
  headers: Record<string, string>,
  map: Record<string, string>,
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
      const products: Array<{ id: number; product_type: string; title: string; vendor: string }> = data.products ?? [];

      if (products.length === 0 && Object.keys(map).length === 0) return false;

      for (const product of products) {
        const pType = (product.product_type || '').trim();
        const vendor = (product.vendor || '').trim();
        // Priority: product_type > vendor > "Sin tipo"
        map[String(product.id)] = pType || vendor || 'Sin tipo';
      }

      url = parsePaginationNext(res.headers.get('link'));
    }

    return Object.keys(map).length > 0;
  } catch {
    return false;
  }
}

/**
 * Fallback: extract product types from recent orders' line_items.
 * Uses title as the product identifier (always available).
 */
async function tryOrdersApi(
  baseUrl: string,
  headers: Record<string, string>,
  map: Record<string, string>,
): Promise<void> {
  // Fetch last 250 orders to get a good sample of products
  // Fetch recent orders — don't filter fields so we get full line_items data
  const url = `${baseUrl}/orders.json?limit=250&status=any`;
  const res = await fetch(url, { headers });

  if (!res.ok) return;

  const data = await res.json();
  const orders: Array<{ line_items: Array<{ product_id: number; title: string; vendor?: string }> }> = data.orders ?? [];

  for (const order of orders) {
    for (const item of order.line_items ?? []) {
      if (!item.product_id) continue;
      const key = String(item.product_id);
      if (map[key]) continue; // Already mapped
      // Use title as the product identifier (always available in orders)
      map[key] = item.title || 'Sin tipo';
    }
  }
}

/**
 * GET /api/v1/products/scan
 * Returns cached product types and current filter without calling Shopify.
 */
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { productTypeCache: true, allowedProductTypes: true },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  const cache = (tenant.productTypeCache as Record<string, string> | null) ?? {};
  const uniqueTypes = [...new Set(Object.values(cache))].sort();

  return apiSuccess({
    productTypes: uniqueTypes,
    allowedProductTypes: (tenant.allowedProductTypes as string[] | null) ?? [],
    totalProducts: Object.keys(cache).length,
  });
}

function parsePaginationNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}
