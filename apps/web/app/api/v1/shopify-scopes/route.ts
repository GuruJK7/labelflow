import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { decryptIfPresent } from '@/lib/encryption';

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify not configured', 400);
  }

  const token = decryptIfPresent(tenant.shopifyToken);
  if (!token) return apiError('Cannot decrypt token', 500);

  // Check current access scopes
  const res = await fetch(
    `https://${tenant.shopifyStoreUrl}/admin/api/2024-01/access_scopes.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[shopify-scopes] Shopify API ${res.status}: ${errText.substring(0, 500)}`);
    return apiError('Error consultando scopes de Shopify', 502);
  }

  const data = await res.json();
  const scopes = (data.access_scopes ?? []).map((s: { handle: string }) => s.handle);

  // Check which critical scopes are missing
  const required = [
    'read_orders', 'write_orders',
    'read_fulfillments', 'write_fulfillments',
    'read_products', 'write_products',
    'read_assigned_fulfillment_orders', 'write_assigned_fulfillment_orders',
    'write_merchant_managed_fulfillment_orders',
    'read_merchant_managed_fulfillment_orders',
  ];

  const missing = required.filter(s => !scopes.includes(s));

  return apiSuccess({ scopes, missing, total: scopes.length });
}
