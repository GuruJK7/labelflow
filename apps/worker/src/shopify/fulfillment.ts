import { AxiosInstance, AxiosError } from 'axios';
import logger from '../logger';

const DAC_TRACKING_BASE_URL = 'https://www.dac.com.uy/envios/rastrear';

/**
 * Thrown when the order is already fulfilled (or partially fulfilled) — typically
 * because another tenant pointing at the same Shopify shop got there first, or an
 * operator marked it manually. Not an error from the customer's perspective:
 * tracking already went out, we just shouldn't double-fulfill.
 */
export class ShopifyAlreadyFulfilledError extends Error {
  readonly isAlreadyFulfilled = true as const;
  constructor(readonly orderId: number, readonly status: string) {
    super(`Order ${orderId} already ${status} in Shopify — skipping fulfillment`);
    this.name = 'ShopifyAlreadyFulfilledError';
  }
}

/**
 * Thrown when Shopify rejects the call with 403 + "required permission(s)" — the
 * Custom App is missing the four `*_fulfillment_orders` scopes. No code-level
 * workaround exists: the operator must update scopes in Shopify Partners and
 * reinstall. The error message is the actionable instruction itself, surfaced in
 * the dashboard runlog.
 */
export class ShopifyMissingScopesError extends Error {
  readonly isMissingScopes = true as const;
  static readonly REQUIRED_SCOPES = [
    'read_assigned_fulfillment_orders',
    'write_assigned_fulfillment_orders',
    'read_merchant_managed_fulfillment_orders',
    'write_merchant_managed_fulfillment_orders',
  ];
  constructor(rawBody: string) {
    super(
      `Shopify rejected fulfillment: missing scopes. Required: ${ShopifyMissingScopesError.REQUIRED_SCOPES.join(', ')}. ` +
        `Fix: Shopify Partners → app config → Configuration → API access scopes → tick the four scopes → save → reinstall app on the shop. ` +
        `Raw: ${rawBody.slice(0, 200)}`,
    );
    this.name = 'ShopifyMissingScopesError';
  }
}

/**
 * Detects "missing fulfillment_orders scopes" responses. Shopify returns this
 * for any of the modern fulfillment endpoints when the four `*_fulfillment_orders`
 * scopes are not granted, with body `{"errors":"The api_client does not have the
 * required permission(s)."}`.
 */
function isMissingScopesError(err: unknown): { body: string } | null {
  const ae = err as AxiosError;
  if (!ae?.isAxiosError || ae.response?.status !== 403) return null;
  const body = typeof ae.response.data === 'string'
    ? ae.response.data
    : JSON.stringify(ae.response.data ?? {});
  if (/required permission/i.test(body)) return { body };
  return null;
}

/**
 * Re-fetches the order's fulfillment_status from Shopify just before attempting
 * fulfillment. This catches three races:
 *   1. Multi-tenant: another tenant with the same shop fulfilled it first.
 *   2. Manual: an operator marked it Prepared in Shopify admin.
 *   3. Re-run: the worker is reprocessing an order that already shipped.
 * Uses only `read_orders`, which is part of every install.
 */
async function getOrderFulfillmentStatus(
  client: AxiosInstance,
  orderId: number,
): Promise<string | null> {
  const { data } = await client.get(`/orders/${orderId}.json`, {
    params: { fields: 'id,fulfillment_status' },
  });
  return data.order?.fulfillment_status ?? null;
}

/**
 * Gets fulfillment order IDs for a Shopify order.
 * When forceAll is true, includes all non-cancelled fulfillment orders (not just "open").
 * This allows fulfilling orders regardless of their product/fulfillment status.
 */
async function getFulfillmentOrderIds(client: AxiosInstance, orderId: number, forceAll = false): Promise<number[]> {
  let data;
  try {
    const res = await client.get(`/orders/${orderId}/fulfillment_orders.json`);
    data = res.data;
  } catch (err) {
    const missing = isMissingScopesError(err);
    if (missing) throw new ShopifyMissingScopesError(missing.body);
    throw err;
  }
  const fulfillmentOrders = data.fulfillment_orders ?? [];

  logger.info(
    { orderId, count: fulfillmentOrders.length, statuses: fulfillmentOrders.map((fo: { id: number; status: string }) => `${fo.id}:${fo.status}`) },
    'Fulfillment orders found'
  );

  // In "always" mode, accept any non-cancelled/non-closed status
  const eligibleStatuses = forceAll
    ? ['open', 'in_progress', 'on_hold', 'scheduled', 'incomplete']
    : ['open'];

  const filtered = fulfillmentOrders.filter(
    (fo: { id: number; status: string }) => eligibleStatuses.includes(fo.status)
  );

  if (filtered.length === 0) {
    const allStatuses = fulfillmentOrders.map((fo: { status: string }) => fo.status).join(', ');
    // All statuses 'closed' = already fulfilled. Surface as the typed error so
    // the caller can downgrade the log level.
    if (fulfillmentOrders.length > 0 && fulfillmentOrders.every((fo: { status: string }) => fo.status === 'closed')) {
      throw new ShopifyAlreadyFulfilledError(orderId, 'closed (all fulfillment_orders closed)');
    }
    throw new Error(`No fulfillable orders for ${orderId} (found: [${allStatuses || 'none'}], accepted: [${eligibleStatuses.join(',')}])`);
  }

  return filtered.map((fo: { id: number }) => fo.id);
}

/**
 * Creates a fulfillment in Shopify with DAC tracking info and notifies the customer.
 *
 * This marks the order as "Preparado" (Fulfilled) in Shopify, sets the tracking
 * number (guia DAC), company as "Other", the DAC tracking URL, and sends
 * Shopify's built-in fulfillment notification to the customer.
 *
 * Throws:
 *   - `ShopifyAlreadyFulfilledError` if the order is already (partially) fulfilled.
 *     The caller should treat this as a non-error and skip silently.
 *   - `ShopifyMissingScopesError` if the app is missing fulfillment_orders scopes.
 *     The error message contains the action items for the operator.
 *   - `Error` for any other failure (network, invalid guia, Shopify rejection).
 */
export async function fulfillOrderWithTracking(
  client: AxiosInstance,
  orderId: number,
  guia: string,
  dacTrackingUrl?: string,
  forceAll = false,
): Promise<void> {
  if (!guia || guia.startsWith('PENDING-')) {
    throw new Error(`Cannot fulfill order ${orderId}: invalid guia "${guia}"`);
  }

  // Pre-check: if Shopify itself already considers the order fulfilled or
  // partial, don't even try — bail out as AlreadyFulfilled. This handles the
  // multi-tenant-same-shop race (the user's strategic ask) and any operator
  // who manually fulfilled the order in Shopify admin between fetch and now.
  const status = await getOrderFulfillmentStatus(client, orderId);
  if (status === 'fulfilled' || status === 'partial') {
    throw new ShopifyAlreadyFulfilledError(orderId, status);
  }

  const fulfillmentOrderIds = await getFulfillmentOrderIds(client, orderId, forceAll);
  // Use the real DAC tracking URL if available, otherwise construct fallback
  const trackingUrl = dacTrackingUrl || `${DAC_TRACKING_BASE_URL}?guia=${encodeURIComponent(guia)}`;

  let data;
  try {
    const res = await client.post('/fulfillments.json', {
      fulfillment: {
        line_items_by_fulfillment_order: fulfillmentOrderIds.map((id) => ({
          fulfillment_order_id: id,
        })),
        tracking_info: {
          number: guia,
          url: trackingUrl,
          company: 'Other',
        },
        notify_customer: true,
      },
    });
    data = res.data;
  } catch (err) {
    const missing = isMissingScopesError(err);
    if (missing) throw new ShopifyMissingScopesError(missing.body);
    throw err;
  }

  if (!data.fulfillment?.id) {
    throw new Error(`Shopify fulfillment creation failed: ${JSON.stringify(data.errors ?? data)}`);
  }

  logger.info({ orderId, guia, fulfillmentId: data.fulfillment.id, trackingUrl }, 'Order fulfilled in Shopify with DAC tracking');
}
