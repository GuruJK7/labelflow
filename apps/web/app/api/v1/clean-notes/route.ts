import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { decryptIfPresent } from '@/lib/encryption';

/**
 * POST /api/v1/clean-notes
 * Cleans up error spam from order notes in Shopify.
 * Body: { orderNumbers: ["10900", "10902"] }
 */
export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify no configurado', 400);
  }

  const token = decryptIfPresent(tenant.shopifyToken);
  if (!token) return apiError('Token invalid', 500);

  const body = await req.json().catch(() => ({}));
  const orderNumbers: string[] = body.orderNumbers ?? [];

  if (orderNumbers.length === 0) return apiError('No order numbers provided', 400);

  const results: { order: string; status: string }[] = [];

  for (const orderNum of orderNumbers) {
    try {
      // Search for the order by name. encodeURIComponent para evitar que
      // un orderNum con `&` o `=` inyecte query params extra.
      const searchRes = await fetch(
        `https://${tenant.shopifyStoreUrl}/admin/api/2024-01/orders.json?name=%23${encodeURIComponent(orderNum)}&status=any`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      const searchData = await searchRes.json();
      const order = searchData.orders?.[0];

      if (!order) {
        results.push({ order: orderNum, status: 'not found' });
        continue;
      }

      const currentNote: string = order.note ?? '';

      // Remove all "LabelFlow ERROR:" lines, keep "LabelFlow-GUIA:" lines
      const cleanedLines = currentNote
        .split('\n')
        .filter((line: string) => !line.includes('LabelFlow ERROR:'))
        .join('\n')
        .trim();

      // Update the order notes
      await fetch(
        `https://${tenant.shopifyStoreUrl}/admin/api/2024-01/orders/${order.id}.json`,
        {
          method: 'PUT',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ order: { id: order.id, note: cleanedLines } }),
        }
      );

      results.push({ order: orderNum, status: `cleaned (removed ${currentNote.split('LabelFlow ERROR:').length - 1} errors)` });
    } catch (err) {
      results.push({ order: orderNum, status: `error: ${(err as Error).message}` });
    }
  }

  return apiSuccess({ results });
}
