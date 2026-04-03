import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { decryptIfPresent } from '@/lib/encryption';

const DAC_TRACKING_BASE_URL = 'https://www.dac.com.uy/envios/rastrear';

/**
 * POST /api/v1/fulfill-retry
 * Retroactively fulfills orders in Shopify that have a DAC guia but were never fulfilled.
 * Body: { labelIds?: string[] }  — if empty, auto-detects all CREATED/COMPLETED labels missing fulfillment.
 */
export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenantId = auth.tenantId;

  let labelIds: string[] = [];
  try {
    const body = await req.json();
    labelIds = body?.labelIds ?? [];
  } catch {
    // no body
  }

  // Load tenant credentials
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify credentials not configured', 400);
  }

  const shopifyToken = decryptIfPresent(tenant.shopifyToken);
  if (!shopifyToken) {
    return apiError('Cannot decrypt Shopify token', 500);
  }

  const baseUrl = `https://${tenant.shopifyStoreUrl}/admin/api/2024-01`;

  // Find labels to fulfill
  const where: Record<string, unknown> = {
    tenantId,
    status: { in: ['CREATED', 'COMPLETED'] },
    dacGuia: { not: null },
  };
  if (labelIds.length > 0) {
    where.id = { in: labelIds };
  }

  const labels = await db.label.findMany({
    where,
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      dacGuia: true,
    },
  });

  if (labels.length === 0) {
    return apiSuccess({ fulfilled: 0, results: [] }, { message: 'No labels found to fulfill' });
  }

  const results: { orderName: string; guia: string; success: boolean; error?: string }[] = [];

  for (const label of labels) {
    const guia = label.dacGuia!;
    if (guia.startsWith('PENDING-')) {
      results.push({ orderName: label.shopifyOrderName, guia, success: false, error: 'Guia is pending' });
      continue;
    }

    try {
      // Step 1: Get open fulfillment orders
      const foRes = await fetch(`${baseUrl}/orders/${label.shopifyOrderId}/fulfillment_orders.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
      });

      if (!foRes.ok) {
        const errText = await foRes.text();
        // If 404 or already fulfilled, check order status
        results.push({ orderName: label.shopifyOrderName, guia, success: false, error: `Fulfillment orders fetch failed (${foRes.status}): ${errText.substring(0, 200)}` });
        continue;
      }

      const foData = await foRes.json();
      const openOrders = (foData.fulfillment_orders ?? []).filter(
        (fo: { status: string }) => fo.status === 'open'
      );

      if (openOrders.length === 0) {
        // Might already be fulfilled
        results.push({ orderName: label.shopifyOrderName, guia, success: true, error: 'Already fulfilled (no open fulfillment orders)' });
        continue;
      }

      // Step 2: Create fulfillment with tracking
      const trackingUrl = `${DAC_TRACKING_BASE_URL}?guia=${encodeURIComponent(guia)}`;
      const fulfillRes = await fetch(`${baseUrl}/fulfillments.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fulfillment: {
            line_items_by_fulfillment_order: openOrders.map((fo: { id: number }) => ({
              fulfillment_order_id: fo.id,
            })),
            tracking_info: {
              number: guia,
              url: trackingUrl,
              company: 'Other',
            },
            notify_customer: true,
          },
        }),
      });

      if (!fulfillRes.ok) {
        const errText = await fulfillRes.text();
        results.push({ orderName: label.shopifyOrderName, guia, success: false, error: `Fulfillment failed (${fulfillRes.status}): ${errText.substring(0, 200)}` });
        continue;
      }

      const fulfillData = await fulfillRes.json();
      if (!fulfillData.fulfillment?.id) {
        results.push({ orderName: label.shopifyOrderName, guia, success: false, error: 'No fulfillment ID returned' });
        continue;
      }

      // Step 3: Also tag the order as "RASTREO ENVIADO"
      await fetch(`${baseUrl}/orders/${label.shopifyOrderId}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: { id: Number(label.shopifyOrderId), tags: 'RASTREO ENVIADO' } }),
      }).catch(() => {});

      results.push({ orderName: label.shopifyOrderName, guia, success: true });
    } catch (err) {
      results.push({ orderName: label.shopifyOrderName, guia, success: false, error: (err as Error).message });
    }
  }

  const fulfilled = results.filter(r => r.success && !r.error?.includes('Already')).length;
  return apiSuccess({ fulfilled, total: labels.length, results });
}
