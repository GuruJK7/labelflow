import logger from '../logger';
import { ShopifyAlreadyFulfilledError, ShopifyMissingScopesError } from './fulfillment';
import {
  assertNoUserErrors,
  isGraphqlAccessDenied,
  type ShopifyGraphqlClient,
  type UserError,
} from './graphql-client';
import { orderGid, mapDisplayFulfillmentStatus, mapFulfillmentOrderStatus } from './graphql-adapter';

/**
 * Espejo GraphQL de `fulfillment.ts` (D27). Misma firma pública
 * (`fulfillOrderWithTracking`) y mismos errores tipados — los importa de
 * `fulfillment.ts`, que no se toca, así los `instanceof` de los jobs siguen
 * valiendo venga por donde venga el fulfillment.
 *
 * Tres pasos REST → dos llamadas GraphQL:
 *   (1)+(2) `order { displayFulfillmentStatus fulfillmentOrders { id status } }`
 *           cubre el pre-check anti doble fulfillment y la lista de FO.
 *   (3)     `fulfillmentCreate(fulfillment: { lineItemsByFulfillmentOrder,
 *           trackingInfo { number url company }, notifyCustomer: true })`.
 *           Sin `fulfillmentOrderLineItems`: "If you don't specify line items,
 *           then the mutation fulfills all items in the fulfillment order"
 *           (doc de fulfillmentCreate 2026-07) — igual que el POST REST de hoy.
 *
 * Permisos: en GraphQL llegan como HTTP 200 + errors[].extensions.code
 * ACCESS_DENIED; se traducen a ShopifyMissingScopesError para que el runlog
 * siga mostrando la instrucción accionable.
 */

const DAC_TRACKING_BASE_URL = 'https://www.dac.com.uy/envios/rastrear';

export const FULFILLMENT_ORDERS_QUERY = `query LabelFlowFulfillmentOrders($id: ID!) {
  order(id: $id) {
    id
    legacyResourceId
    displayFulfillmentStatus
    fulfillmentOrders(first: 50) {
      nodes {
        id
        status
        requestStatus
      }
    }
  }
}`;

export const FULFILLMENT_CREATE_MUTATION = `mutation LabelFlowFulfillmentCreate($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment {
      id
      legacyResourceId
      status
      trackingInfo {
        company
        number
        url
      }
    }
    userErrors {
      field
      message
    }
  }
}`;

interface FulfillmentOrdersData {
  order: {
    id: string;
    legacyResourceId: string;
    displayFulfillmentStatus: string | null;
    fulfillmentOrders: { nodes: Array<{ id: string; status: string; requestStatus?: string | null }> };
  } | null;
}

interface FulfillmentCreateData {
  fulfillmentCreate: {
    fulfillment: { id: string; legacyResourceId?: string | null; status?: string | null } | null;
    userErrors: UserError[];
  };
}

function rethrowAccessDenied(err: unknown): never {
  if (isGraphqlAccessDenied(err)) {
    throw new ShopifyMissingScopesError(JSON.stringify(err.errors.map((e) => e.message)));
  }
  throw err;
}

/**
 * Pre-check + FO elegibles en una sola query. Devuelve los GIDs de los
 * fulfillment orders que se van a cerrar (van directo a `fulfillmentOrderId`).
 */
async function getEligibleFulfillmentOrderGids(
  client: ShopifyGraphqlClient,
  orderId: number,
  forceAll: boolean,
): Promise<string[]> {
  let data: FulfillmentOrdersData;
  try {
    data = await client.request<FulfillmentOrdersData>(FULFILLMENT_ORDERS_QUERY, { id: orderGid(orderId) });
  } catch (err) {
    rethrowAccessDenied(err);
  }
  if (!data.order) {
    throw new Error(`Order ${orderId} not found in Shopify (GraphQL)`);
  }
  // Permiso faltante SÓLO en el campo: Shopify manda el pedido con
  // `fulfillmentOrders: null` + errors[] por path (el cliente no aborta).
  if (!data.order.fulfillmentOrders) {
    throw new ShopifyMissingScopesError(JSON.stringify(client.lastErrors.map((e) => e.message)));
  }

  const status = mapDisplayFulfillmentStatus(data.order.displayFulfillmentStatus);
  if (status === 'fulfilled' || status === 'partial') {
    throw new ShopifyAlreadyFulfilledError(orderId, status);
  }

  const fulfillmentOrders = data.order.fulfillmentOrders.nodes.map((fo) => ({
    id: fo.id,
    status: mapFulfillmentOrderStatus(fo.status),
  }));

  logger.info(
    { orderId, count: fulfillmentOrders.length, statuses: fulfillmentOrders.map((fo) => `${fo.id}:${fo.status}`) },
    'Fulfillment orders found',
  );

  const eligibleStatuses = forceAll
    ? ['open', 'in_progress', 'on_hold', 'scheduled', 'incomplete']
    : ['open'];

  const filtered = fulfillmentOrders.filter((fo) => eligibleStatuses.includes(fo.status));

  if (filtered.length === 0) {
    const allStatuses = fulfillmentOrders.map((fo) => fo.status).join(', ');
    if (fulfillmentOrders.length > 0 && fulfillmentOrders.every((fo) => fo.status === 'closed')) {
      throw new ShopifyAlreadyFulfilledError(orderId, 'closed (all fulfillment_orders closed)');
    }
    throw new Error(`No fulfillable orders for ${orderId} (found: [${allStatuses || 'none'}], accepted: [${eligibleStatuses.join(',')}])`);
  }

  return filtered.map((fo) => fo.id);
}

export async function fulfillOrderWithTracking(
  client: ShopifyGraphqlClient,
  orderId: number,
  guia: string,
  dacTrackingUrl?: string,
  forceAll = false,
  opts?: { company?: string; sinUrl?: boolean },
): Promise<void> {
  if (!guia || guia.startsWith('PENDING-')) {
    throw new Error(`Cannot fulfill order ${orderId}: invalid guia "${guia}"`);
  }

  const fulfillmentOrderGids = await getEligibleFulfillmentOrderGids(client, orderId, forceAll);

  const trackingUrl = dacTrackingUrl
    || (opts?.sinUrl ? undefined : `${DAC_TRACKING_BASE_URL}?guia=${encodeURIComponent(guia)}`);

  let data: FulfillmentCreateData;
  try {
    data = await client.request<FulfillmentCreateData>(FULFILLMENT_CREATE_MUTATION, {
      fulfillment: {
        lineItemsByFulfillmentOrder: fulfillmentOrderGids.map((fulfillmentOrderId) => ({ fulfillmentOrderId })),
        trackingInfo: {
          number: guia,
          ...(trackingUrl ? { url: trackingUrl } : {}),
          company: opts?.company ?? 'Other',
        },
        notifyCustomer: true,
      },
    });
  } catch (err) {
    rethrowAccessDenied(err);
  }

  const payload = data.fulfillmentCreate;
  assertNoUserErrors('fulfillmentCreate', payload?.userErrors);
  if (!payload?.fulfillment?.id) {
    throw new Error(`Shopify fulfillment creation failed: ${JSON.stringify(payload ?? data)}`);
  }

  logger.info(
    {
      orderId,
      guia,
      fulfillmentId: payload.fulfillment.legacyResourceId ?? payload.fulfillment.id,
      trackingUrl,
    },
    'Order fulfilled in Shopify with DAC tracking',
  );
}
