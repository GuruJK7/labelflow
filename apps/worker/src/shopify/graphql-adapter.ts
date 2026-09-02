import type { ShopifyOrder } from './types';

/**
 * Adaptador GraphQL → forma REST (D27).
 *
 * Funciones PURAS: reciben nodos tal como los devuelve la Admin API GraphQL
 * 2026-07 y producen exactamente el `ShopifyOrder` de `types.ts` que hoy
 * consumen los jobs, las reglas y `dac/shipment.ts` (intocable). Cada campo
 * sigue el mapeo del diseño verificado contra shopify.dev:
 *
 *   id               ← Number(legacyResourceId)   (mismo número que el id REST)
 *   tags             ← tags.join(', ')            (REST es CSV)
 *   fulfillment_status ← displayFulfillmentStatus (FULFILLED→'fulfilled',
 *                        PARTIALLY_FULFILLED→'partial', RESTOCKED→'restocked',
 *                        resto → null)
 *   note_attributes  ← customAttributes {key→name, value}
 *   total_price      ← totalPriceSet.shopMoney.amount (antes de devoluciones,
 *                      igual que REST; NO currentTotalPriceSet)
 *   customer         ← null (la app pública no tiene read_customers; ver D27)
 *
 * Todo campo nullable en GraphQL cae a '' o null según lo que declara
 * `types.ts`, para que ningún consumidor vea un `undefined` nuevo.
 */

export interface GqlMoney {
  amount: string;
  currencyCode?: string;
}

export interface GqlMailingAddress {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  country?: string | null;
  countryCodeV2?: string | null;
}

export interface GqlLineItemNode {
  id: string;
  title: string;
  variantTitle?: string | null;
  quantity: number;
  sku?: string | null;
  product?: { legacyResourceId: string } | null;
  originalUnitPriceSet?: { shopMoney: GqlMoney } | null;
}

export interface GqlPageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

export interface GqlOrderNode {
  id: string;
  legacyResourceId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  tags: string[];
  createdAt?: string;
  currencyCode?: string;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  totalPriceSet?: { shopMoney: GqlMoney } | null;
  customAttributes?: Array<{ key: string; value?: string | null }> | null;
  shippingAddress?: GqlMailingAddress | null;
  billingAddress?: { phone?: string | null } | null;
  lineItems?: { pageInfo: GqlPageInfo; nodes: GqlLineItemNode[] } | null;
}

/** GID de un pedido a partir del id numérico REST (docs/api/usage/gids). */
export function orderGid(orderId: number | string): string {
  return `gid://shopify/Order/${orderId}`;
}

/** `gid://shopify/Order/123` → 123. Devuelve NaN si no parsea. */
export function legacyIdFromGid(gid: string): number {
  const m = /\/(\d+)$/.exec(gid);
  return m ? Number(m[1]) : NaN;
}

/** OrderDisplayFulfillmentStatus (enum 2026-07) → propiedad REST `fulfillment_status`. */
export function mapDisplayFulfillmentStatus(status: string | null | undefined): string | null {
  switch (status) {
    case 'FULFILLED':
      return 'fulfilled';
    case 'PARTIALLY_FULFILLED':
      return 'partial';
    case 'RESTOCKED':
      return 'restocked';
    default:
      // UNFULFILLED, OPEN, IN_PROGRESS, ON_HOLD, SCHEDULED, PENDING_FULFILLMENT,
      // REQUEST_DECLINED y cualquier valor futuro: REST los muestra como null.
      return null;
  }
}

/** OrderDisplayFinancialStatus → `financial_status` REST (nadie lo lee; compatibilidad). */
export function mapDisplayFinancialStatus(status: string | null | undefined): string | null {
  return status ? status.toLowerCase() : null;
}

/** FulfillmentOrderStatus (OPEN, IN_PROGRESS, …) → strings REST ('open', 'in_progress', …). */
export function mapFulfillmentOrderStatus(status: string): string {
  return status.toLowerCase();
}

export function tagsToCsv(tags: string[] | null | undefined): string {
  return (tags ?? []).join(', ');
}

export function toRestLineItem(li: GqlLineItemNode): ShopifyOrder['line_items'][number] & {
  variant_title?: string | null;
} {
  return {
    title: li.title,
    quantity: li.quantity,
    price: li.originalUnitPriceSet?.shopMoney?.amount ?? '0.00',
    product_id: li.product?.legacyResourceId ? Number(li.product.legacyResourceId) : null,
    sku: li.sku ?? null,
    variant_title: li.variantTitle ?? null,
  };
}

export function toRestShippingAddress(addr: GqlMailingAddress | null | undefined): ShopifyOrder['shipping_address'] {
  if (!addr) return null;
  const out: NonNullable<ShopifyOrder['shipping_address']> & {
    province_code?: string | null;
    country_code?: string | null;
  } = {
    first_name: addr.firstName ?? '',
    last_name: addr.lastName ?? '',
    phone: addr.phone ?? '',
    address1: addr.address1 ?? '',
    address2: addr.address2 ?? '',
    city: addr.city ?? '',
    province: addr.province ?? '',
    zip: addr.zip ?? '',
    country: addr.country ?? '',
    province_code: addr.provinceCode ?? null,
    country_code: addr.countryCodeV2 ?? null,
  };
  return out;
}

/**
 * Nodo `Order` de GraphQL → `ShopifyOrder` REST. `extraLineItems` son los
 * ítems que se completaron paginando (REST devuelve todos de un saque).
 */
export function toRestOrder(node: GqlOrderNode, extraLineItems: GqlLineItemNode[] = []): ShopifyOrder & {
  financial_status: string | null;
  created_at?: string;
  admin_graphql_api_id: string;
} {
  const lineNodes = [...(node.lineItems?.nodes ?? []), ...extraLineItems];
  return {
    id: Number(node.legacyResourceId),
    admin_graphql_api_id: node.id,
    name: node.name,
    email: node.email ?? '',
    phone: node.phone ?? null,
    total_price: node.totalPriceSet?.shopMoney?.amount ?? '0.00',
    currency: node.currencyCode ?? node.totalPriceSet?.shopMoney?.currencyCode ?? 'UYU',
    tags: tagsToCsv(node.tags),
    fulfillment_status: mapDisplayFulfillmentStatus(node.displayFulfillmentStatus),
    financial_status: mapDisplayFinancialStatus(node.displayFinancialStatus),
    created_at: node.createdAt,
    note: node.note ?? null,
    note_attributes: (node.customAttributes ?? []).map((a) => ({ name: a.key, value: a.value ?? '' })),
    shipping_address: toRestShippingAddress(node.shippingAddress),
    billing_address: node.billingAddress ? { phone: node.billingAddress.phone ?? null } : null,
    // Sin read_customers no se puede pedir `customer`: resolveOrderPhone
    // degrada a shipping/billing/order.phone y parseCustomerTags da [].
    customer: null,
    line_items: lineNodes.map(toRestLineItem),
  };
}
