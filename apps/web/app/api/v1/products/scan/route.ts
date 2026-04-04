import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { decryptIfPresent } from '@/lib/encryption';

/**
 * POST /api/v1/products/scan
 * Fetches all products from Shopify, builds product_id→product_type map,
 * caches it in tenant.productTypeCache, returns unique product types.
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

  try {
    const productTypeMap: Record<string, string> = {};
    let url: string | null = `https://${tenant.shopifyStoreUrl}/admin/api/2024-01/products.json?fields=id,product_type,title&limit=250`;

    while (url) {
      const res = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        return apiError(`Shopify API error: ${res.status} - ${errText}`, 502);
      }

      const data = await res.json();
      const products: Array<{ id: number; product_type: string; title: string }> = data.products ?? [];

      for (const product of products) {
        // Use product_type if set, otherwise use "Sin tipo" as fallback
        const pType = (product.product_type || '').trim();
        productTypeMap[String(product.id)] = pType || 'Sin tipo';
      }

      // Follow pagination via Link header
      const linkHeader = res.headers.get('link');
      url = parsePaginationNext(linkHeader);
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
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    return apiError(`Error escaneando productos: ${(err as Error).message}`, 500);
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
