import logger from '../logger';
import type { ShopifyOrder } from './types';
import {
  assertNoUserErrors,
  isGraphqlMaxCostExceeded,
  type ShopifyGraphqlClient,
  type UserError,
} from './graphql-client';
import {
  orderGid,
  toRestOrder,
  mapDisplayFulfillmentStatus,
  tagsToCsv,
  type GqlLineItemNode,
  type GqlOrderNode,
  type GqlPageInfo,
} from './graphql-adapter';

/**
 * Espejo GraphQL de `orders.ts` (D27): mismas funciones públicas, mismas
 * firmas salvo el cliente (GraphQL en vez de axios), misma forma de salida.
 * `orders.ts` NO se toca: los tenants con token de custom app siguen por ahí.
 *
 * Nombres de queries/mutaciones/campos verificados contra la doc 2026-07
 * (queries/orders, queries/order, objects/Order, mutations/tagsAdd,
 * mutations/orderUpdate, input-objects/OrderInput).
 */

const PROCESSED_TAG = 'RASTREO ENVIADO';
const GUIA_NOTE_PREFIX = 'LabelFlow-GUIA:';

/** Límite REST que hay que cubrir (`limit=250` en orders.ts). */
const REST_LIST_LIMIT = 250;
/** Página inicial; se achica sola si Shopify contesta MAX_COST_EXCEEDED. */
const DEFAULT_PAGE = 25;
const DEFAULT_LINE_ITEMS = 50;
const MIN_PAGE = 5;
const MIN_LINE_ITEMS = 10;
const LINE_ITEMS_FULL_PAGE = 250;

const LINE_ITEM_FIELDS = `
        id
        title
        variantTitle
        quantity
        sku
        product {
          legacyResourceId
        }
        originalUnitPriceSet {
          shopMoney {
            amount
          }
        }`;

export const ORDERS_QUERY = `query LabelFlowOrders($first: Int!, $after: String, $query: String, $reverse: Boolean!, $lineItemsFirst: Int!) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: $reverse) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      legacyResourceId
      name
      email
      phone
      note
      tags
      createdAt
      currencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      customAttributes {
        key
        value
      }
      shippingAddress {
        firstName
        lastName
        phone
        address1
        address2
        city
        province
        provinceCode
        zip
        country
        countryCodeV2
      }
      billingAddress {
        phone
      }
      lineItems(first: $lineItemsFirst) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {${LINE_ITEM_FIELDS}
        }
      }
    }
  }
}`;

export const ORDER_BY_ID_QUERY = `query LabelFlowOrderById($id: ID!, $lineItemsFirst: Int!, $lineItemsAfter: String) {
  order(id: $id) {
    id
    legacyResourceId
    name
    note
    tags
    displayFulfillmentStatus
    lineItems(first: $lineItemsFirst, after: $lineItemsAfter) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {${LINE_ITEM_FIELDS}
      }
    }
  }
}`;

export const TAGS_ADD_MUTATION = `mutation LabelFlowTagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node {
      id
    }
    userErrors {
      field
      message
    }
  }
}`;

export const ORDER_NOTE_UPDATE_MUTATION = `mutation LabelFlowOrderNoteUpdate($input: OrderInput!) {
  orderUpdate(input: $input) {
    order {
      id
      note
    }
    userErrors {
      field
      message
    }
  }
}`;

/** Equivalente de `financial_status=paid&fulfillment_status=unfulfilled&status=open`. */
export const UNFULFILLED_QUERY_STRING = 'financial_status:paid fulfillment_status:unfulfilled status:open';

interface OrdersData {
  orders: { pageInfo: GqlPageInfo; nodes: GqlOrderNode[] };
}

interface OrderByIdData {
  order: {
    id: string;
    legacyResourceId: string;
    name: string;
    note: string | null;
    tags: string[];
    displayFulfillmentStatus: string | null;
    lineItems: { pageInfo: GqlPageInfo; nodes: GqlLineItemNode[] };
  } | null;
}

/**
 * Completa los line_items de un pedido cuando la primera página no alcanzó.
 * REST devuelve todos los ítems de un saque; acá se pagina hasta agotar.
 */
async function fetchRemainingLineItems(
  client: ShopifyGraphqlClient,
  gid: string,
  after: string | null | undefined,
): Promise<GqlLineItemNode[]> {
  const out: GqlLineItemNode[] = [];
  let cursor = after ?? null;
  for (let guard = 0; guard < 20; guard++) {
    const data = await client.request<OrderByIdData>(ORDER_BY_ID_QUERY, {
      id: gid,
      lineItemsFirst: LINE_ITEMS_FULL_PAGE,
      lineItemsAfter: cursor,
    });
    const page = data.order?.lineItems;
    if (!page) break;
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

/**
 * Lista pedidos paginando con cursor hasta `limit` (o hasta agotar). Si
 * Shopify rechaza la página por costo, parte `first`/`lineItemsFirst` a la
 * mitad y reintenta la MISMA página (no asume una fórmula de costo: la doc
 * sólo dice "sized by first/last").
 */
async function listOrders(
  client: ShopifyGraphqlClient,
  opts: { query: string | null; reverse: boolean; limit: number },
): Promise<ShopifyOrder[]> {
  const out: ShopifyOrder[] = [];
  let first = Math.min(DEFAULT_PAGE, opts.limit);
  let lineItemsFirst = DEFAULT_LINE_ITEMS;
  let after: string | null = null;

  while (out.length < opts.limit) {
    const want = Math.min(first, opts.limit - out.length);
    let data: OrdersData;
    try {
      data = await client.request<OrdersData>(ORDERS_QUERY, {
        first: want,
        after,
        query: opts.query,
        reverse: opts.reverse,
        lineItemsFirst,
      });
    } catch (err) {
      if (isGraphqlMaxCostExceeded(err) && (first > MIN_PAGE || lineItemsFirst > MIN_LINE_ITEMS)) {
        first = Math.max(MIN_PAGE, Math.floor(first / 2));
        lineItemsFirst = Math.max(MIN_LINE_ITEMS, Math.floor(lineItemsFirst / 2));
        logger.warn({ storeUrl: client.storeUrl, first, lineItemsFirst }, 'Shopify GraphQL page too expensive, shrinking');
        continue;
      }
      throw err;
    }

    const cost = client.lastCost;
    if (cost) {
      logger.info(
        { storeUrl: client.storeUrl, requested: cost.requestedQueryCost, actual: cost.actualQueryCost, first: want, lineItemsFirst },
        'Shopify GraphQL orders page cost',
      );
    }

    for (const node of data.orders.nodes) {
      let extra: GqlLineItemNode[] = [];
      if (node.lineItems?.pageInfo?.hasNextPage) {
        extra = await fetchRemainingLineItems(client, node.id, node.lineItems.pageInfo.endCursor);
      }
      out.push(toRestOrder(node, extra));
      if (out.length >= opts.limit) break;
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor ?? null;
    if (!after) break;
  }

  return out;
}

export async function getUnfulfilledOrders(
  client: ShopifyGraphqlClient,
  sortDirection: 'oldest_first' | 'newest_first' = 'oldest_first',
): Promise<ShopifyOrder[]> {
  const orders = await listOrders(client, {
    query: UNFULFILLED_QUERY_STRING,
    reverse: sortDirection === 'newest_first',
    limit: REST_LIST_LIMIT,
  });

  // Misma telemetría que orders.ts: pedidos que ya llevan tag/nota nuestra.
  let reprocessCandidates = 0;
  for (const order of orders) {
    const tags = order.tags.split(',').map((t) => t.trim().toLowerCase());
    const hasProcessedTag =
      tags.includes(PROCESSED_TAG.toLowerCase()) ||
      tags.includes('labelflow-procesado');
    const hasGuiaNote = order.note?.includes(GUIA_NOTE_PREFIX) ?? false;
    if (hasProcessedTag || hasGuiaNote) reprocessCandidates++;
  }
  if (reprocessCandidates > 0) {
    logger.info(
      { reprocessCandidates, totalUnfulfilled: orders.length },
      'Shopify returned orders that were previously processed (tag/note still present). ' +
        'Treating as reprocess — Shopify unfulfilled status is authoritative.',
    );
  }

  return orders;
}

/**
 * Modo TEST: los últimos N pedidos sin filtro de estado (REST `status=any`).
 * Sin `query` la conexión `orders` no filtra por estado (la doc no documenta
 * un default de status; se verifica en autoenvia-qa, PENDIENTES.md).
 */
export async function getRecentOrders(
  client: ShopifyGraphqlClient,
  limit: number = 5,
): Promise<ShopifyOrder[]> {
  return listOrders(client, {
    query: null,
    reverse: true,
    limit: Math.max(1, Math.min(limit, REST_LIST_LIMIT)),
  });
}

/**
 * Lo que los jobs leen hoy de `GET /orders/{id}.json` (`data.order?.note`,
 * `tags`, `fulfillment_status`), con la misma forma `{ data: { order } }`.
 * Pide 1 line item para que la query cueste lo mínimo.
 */
export async function getOrderRestShim(
  client: ShopifyGraphqlClient,
  orderId: number,
): Promise<{ data: { order: { id: number; name: string; note: string | null; tags: string; fulfillment_status: string | null } | null } }> {
  const data = await client.request<OrderByIdData>(ORDER_BY_ID_QUERY, {
    id: orderGid(orderId),
    lineItemsFirst: 1,
    lineItemsAfter: null,
  });
  const o = data.order;
  if (!o) return { data: { order: null } };
  return {
    data: {
      order: {
        id: Number(o.legacyResourceId),
        name: o.name,
        note: o.note ?? null,
        tags: tagsToCsv(o.tags),
        fulfillment_status: mapDisplayFulfillmentStatus(o.displayFulfillmentStatus),
      },
    },
  };
}

interface TagsAddData {
  tagsAdd: { node: { id: string } | null; userErrors: UserError[] };
}

/**
 * `tagsAdd` es atómico y de conjunto: no hace falta leer los tags actuales
 * ni deduplicar (orders.ts lo hacía porque `PUT tags` pisa la lista entera).
 * NUNCA usar `orderUpdate(tags)` acá: "Overwrites the existing tags".
 */
export async function addOrderTag(client: ShopifyGraphqlClient, orderId: number, tag: string): Promise<void> {
  const data = await client.request<TagsAddData>(TAGS_ADD_MUTATION, {
    id: orderGid(orderId),
    tags: [tag],
  });
  assertNoUserErrors('tagsAdd', data.tagsAdd?.userErrors);
}

interface OrderUpdateData {
  orderUpdate: { order: { id: string; note: string | null } | null; userErrors: UserError[] };
}

/** `OrderInput.note` sobreescribe: mismo GET previo + concatenación con '\n' que hoy. */
export async function addOrderNote(client: ShopifyGraphqlClient, orderId: number, noteText: string): Promise<void> {
  const { data } = await getOrderRestShim(client, orderId);
  const currentNote: string = data.order?.note ?? '';
  const updatedNote = currentNote ? `${currentNote}\n${noteText}` : noteText;

  const res = await client.request<OrderUpdateData>(ORDER_NOTE_UPDATE_MUTATION, {
    // SÓLO id y note: cualquier otra clave de OrderInput pisa datos del pedido.
    input: { id: orderGid(orderId), note: updatedNote },
  });
  assertNoUserErrors('orderUpdate(note)', res.orderUpdate?.userErrors);
}

export async function markOrderProcessed(
  client: ShopifyGraphqlClient,
  orderId: number,
  guia: string,
): Promise<void> {
  await addOrderTag(client, orderId, PROCESSED_TAG);
  await addOrderNote(client, orderId, `${GUIA_NOTE_PREFIX} ${guia} | ${new Date().toISOString()}`);
  logger.info({ orderId, guia }, 'Order marked as processed in Shopify');
}
