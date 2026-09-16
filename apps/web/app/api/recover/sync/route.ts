import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import { normalizePhone } from '@/lib/recover-utils';
import { shopifyGraphql } from '@/lib/shopify-graphql';

/**
 * POST /api/recover/sync
 * Fetches abandoned checkouts from Shopify and upserts them into RecoverCart.
 *
 * Portado de REST (`GET /admin/api/2024-01/checkouts.json?status=open`) a la
 * query `abandonedCheckouts` del Admin GraphQL (requisito 2.2.4 del App Store:
 * desde el 1/4/2025 una app pública nueva no puede consultar recursos REST).
 *
 * La forma que consume el upsert de abajo (`NormalizedCheckout`) es la MISMA
 * que devolvía REST, así que el bucle de upsert y la respuesta del endpoint
 * (`{ synced, created, updated, totalFromShopify }`) quedaron intactos.
 *
 * Diferencias de la API que hay que tener presentes:
 *  - El `id` de GraphQL es un GID (`gid://shopify/AbandonedCheckout/123`): se
 *    extrae el número para que `shopifyCheckoutId` siga siendo el mismo string
 *    que escribe el webhook de `checkouts/*` (si no, la clave única
 *    `tenantId_shopifyCheckoutId` no matchearía y se duplicarían filas).
 *  - `AbandonedCheckout` no expone `token`: `shopifyCheckoutToken` queda ''.
 *    Hoy nadie lo lee (la URL de recuperación es `abandonedCheckoutUrl`).
 *  - Tampoco expone `email`/`phone` sueltos: salen de `customer`, que pide el
 *    scope `read_customers` — que la app pública NO pide. Si Shopify contesta
 *    ACCESS_DENIED se reintenta la página sin ese bloque: se sincroniza igual,
 *    con el teléfono de las direcciones (que sólo necesitan `read_orders`).
 *  - GraphQL pagina con cursores y cobra por costo de query, no por request:
 *    de ahí el tamaño de página chico y el reintento ante THROTTLED.
 */

/** Tope por página. Con los line items anidados el costo pedido queda ~800 de los 1000 permitidos. */
const CHECKOUTS_PER_PAGE = 25;
/** Line items por checkout. Un carrito con más ítems que esto se trunca acá. */
const LINE_ITEMS_PER_CHECKOUT = 20;
/** Cota dura de páginas (25 × 40 = 1000 checkouts) para que el request no se eternice. */
const MAX_PAGES = 40;
const THROTTLE_RETRIES = 2;
const THROTTLE_WAIT_MS = 1_500;

export async function POST(_req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Get tenant with Shopify credentials
  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify no configurado. Ve a Configuracion para conectar tu tienda.', 400);
  }

  const token = await shopifyAccessForTenant(tenant);
  if (!token) return apiError('Token de Shopify invalido', 400);

  // Ensure RecoverConfig exists for this tenant
  let recoverConfig = await db.recoverConfig.findUnique({
    where: { tenantId: auth.tenantId },
  });
  if (!recoverConfig) {
    recoverConfig = await db.recoverConfig.create({
      data: { tenantId: auth.tenantId },
    });
  }

  try {
    // Fetch abandoned checkouts from Shopify (last 30 days)
    const since = new Date();
    since.setDate(since.getDate() - 30);

    // Mismo filtro que tenía el REST (`created_at_min` + `status=open`), en la
    // sintaxis de búsqueda de Shopify. El timestamp va entrecomillado y sin
    // milisegundos, que es la forma documentada (`created_at:>'2020-10-21T23:39:20Z'`).
    const searchQuery =
      `created_at:>='${since.toISOString().replace(/\.\d{3}Z$/, 'Z')}' status:open`;

    let allCheckouts: NormalizedCheckout[] = [];
    let cursor: string | null = null;
    let includeCustomer = true;
    let pages = 0;
    let truncated = false;

    // Paginate through all results
    for (;;) {
      let page = await fetchCheckoutPage(
        tenant.shopifyStoreUrl,
        token,
        searchQuery,
        cursor,
        includeCustomer,
      );

      // Sin `read_customers` el bloque `customer` es un ACCESS_DENIED que tira
      // toda la query abajo: se repite la MISMA página sin ese bloque.
      if (page.kind === 'no-customer-scope') {
        console.warn('[recover/sync] sin scope read_customers: se sincroniza sin email/telefono del cliente');
        includeCustomer = false;
        page = await fetchCheckoutPage(
          tenant.shopifyStoreUrl,
          token,
          searchQuery,
          cursor,
          false,
        );
      }

      if (page.kind !== 'ok') {
        // Loguear server-side, no leak Shopify internals al cliente.
        console.error(`[recover/sync] Shopify GraphQL: ${page.detail}`);
        return apiError('Error conectando con Shopify', 502);
      }

      allCheckouts = allCheckouts.concat(page.nodes.map(normalizeCheckout));
      pages++;

      if (!page.hasNextPage || !page.endCursor) break;
      if (pages >= MAX_PAGES) {
        truncated = true;
        break;
      }
      cursor = page.endCursor;
    }

    if (truncated) {
      console.warn(
        `[recover/sync] corte en ${MAX_PAGES} paginas (${allCheckouts.length} checkouts): quedaron mas sin sincronizar`,
      );
    }

    // Filter: only abandoned (no completed_at) and with some contact info
    const abandoned = allCheckouts.filter(
      (c) => !c.completed_at && (c.phone || c.email || c.shipping_address?.phone || c.billing_address?.phone)
    );

    // Upsert each abandoned checkout
    let created = 0;
    let updated = 0;
    for (const checkout of abandoned) {
      const phone = normalizePhone(
        checkout.phone ||
        checkout.shipping_address?.phone ||
        checkout.billing_address?.phone ||
        null
      );
      const name = checkout.shipping_address
        ? `${checkout.shipping_address.first_name || ''} ${checkout.shipping_address.last_name || ''}`.trim()
        : checkout.billing_address
          ? `${checkout.billing_address.first_name || ''} ${checkout.billing_address.last_name || ''}`.trim()
          : null;

      const cartItems = (checkout.line_items || []).map((item) => ({
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        variant: item.variant_title || null,
        sku: item.sku || null,
      }));

      const existing = await db.recoverCart.findUnique({
        where: {
          tenantId_shopifyCheckoutId: {
            tenantId: auth.tenantId,
            shopifyCheckoutId: String(checkout.id),
          },
        },
      });

      if (existing) {
        // Only update if not in terminal status
        if (!['RECOVERED', 'OPTED_OUT'].includes(existing.status)) {
          await db.recoverCart.update({
            where: { id: existing.id },
            data: {
              customerPhone: phone,
              customerName: name,
              customerEmail: checkout.email || null,
              cartTotal: parseFloat(checkout.total_price || '0'),
              currency: checkout.presentment_currency || checkout.currency || 'UYU',
              cartItems: JSON.stringify(cartItems),
              checkoutUrl: checkout.abandoned_checkout_url || null,
            },
          });
          updated++;
        }
      } else {
        await db.recoverCart.create({
          data: {
            tenantId: auth.tenantId,
            recoverConfigId: recoverConfig.id,
            shopifyCheckoutId: String(checkout.id),
            shopifyCheckoutToken: checkout.token || '',
            customerPhone: phone,
            customerName: name,
            customerEmail: checkout.email || null,
            cartTotal: parseFloat(checkout.total_price || '0'),
            currency: checkout.presentment_currency || checkout.currency || 'UYU',
            cartItems: JSON.stringify(cartItems),
            checkoutUrl: checkout.abandoned_checkout_url || null,
            status: phone ? 'PENDING' : 'NO_PHONE',
          },
        });
        created++;
      }
    }

    return apiSuccess({
      synced: abandoned.length,
      created,
      updated,
      totalFromShopify: allCheckouts.length,
    });
  } catch (err) {
    return apiError(`Error sincronizando: ${(err as Error).message}`, 500);
  }
}

// ── Types ──

/**
 * Forma que consume el upsert. Es la que devolvía REST: se mantiene tal cual
 * para que portar la lectura no cambie ni un campo de lo que se guarda.
 */
interface NormalizedCheckout {
  id: string;
  token: string;
  email: string | null;
  phone: string | null;
  total_price: string;
  currency: string;
  presentment_currency: string;
  completed_at: string | null;
  abandoned_checkout_url: string;
  line_items: Array<{
    title: string;
    quantity: number;
    price: string;
    variant_title: string | null;
    sku: string | null;
  }>;
  shipping_address: {
    first_name: string;
    last_name: string;
    phone: string | null;
  } | null;
  billing_address: {
    first_name: string;
    last_name: string;
    phone: string | null;
  } | null;
}

interface GqlMoney {
  amount?: string | null;
  currencyCode?: string | null;
}

interface GqlAddress {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

interface GqlAbandonedCheckout {
  id: string;
  abandonedCheckoutUrl?: string | null;
  completedAt?: string | null;
  totalPriceSet?: { shopMoney?: GqlMoney | null; presentmentMoney?: GqlMoney | null } | null;
  customer?: {
    defaultEmailAddress?: { emailAddress?: string | null } | null;
    defaultPhoneNumber?: { phoneNumber?: string | null } | null;
  } | null;
  billingAddress?: GqlAddress | null;
  shippingAddress?: GqlAddress | null;
  lineItems?: {
    nodes?: Array<{
      title?: string | null;
      quantity?: number | null;
      sku?: string | null;
      variantTitle?: string | null;
      originalUnitPriceSet?: { shopMoney?: GqlMoney | null } | null;
    }> | null;
  } | null;
}

interface AbandonedCheckoutsData {
  abandonedCheckouts?: {
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    nodes?: GqlAbandonedCheckout[] | null;
  } | null;
}

type PageOutcome =
  | { kind: 'ok'; nodes: GqlAbandonedCheckout[]; hasNextPage: boolean; endCursor: string | null }
  /** Falta `read_customers`: hay que repetir la página sin el bloque `customer`. */
  | { kind: 'no-customer-scope'; detail: string }
  | { kind: 'failed'; detail: string };

// ── Helpers ──

/**
 * Query de una página de checkouts abandonados. `customer` es opcional porque
 * pide `read_customers`, un scope que la app pública no solicita.
 */
function buildAbandonedCheckoutsQuery(includeCustomer: boolean): string {
  const customerBlock = includeCustomer
    ? `        customer {
          defaultEmailAddress { emailAddress }
          defaultPhoneNumber { phoneNumber }
        }
`
    : '';

  return `query RecoverAbandonedCheckouts($first: Int!, $after: String, $query: String) {
  abandonedCheckouts(first: $first, after: $after, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      abandonedCheckoutUrl
      completedAt
      totalPriceSet {
        shopMoney { amount currencyCode }
        presentmentMoney { currencyCode }
      }
${customerBlock}      billingAddress { firstName lastName phone }
      shippingAddress { firstName lastName phone }
      lineItems(first: ${LINE_ITEMS_PER_CHECKOUT}) {
        nodes {
          title
          quantity
          sku
          variantTitle
          originalUnitPriceSet { shopMoney { amount } }
        }
      }
    }
  }
}`;
}

async function fetchCheckoutPage(
  shop: string,
  accessToken: string,
  searchQuery: string,
  cursor: string | null,
  includeCustomer: boolean,
): Promise<PageOutcome> {
  const query = buildAbandonedCheckoutsQuery(includeCustomer);
  const variables = { first: CHECKOUTS_PER_PAGE, after: cursor, query: searchQuery };

  for (let intento = 0; ; intento++) {
    const res = await shopifyGraphql<AbandonedCheckoutsData>(shop, accessToken, query, variables);

    // Los errores de GraphQL viajan en `errors` con HTTP 200: no alcanza el status.
    if (res.errors.length > 0) {
      const codigos = res.errors.map((e) => e.extensions?.code ?? '').filter(Boolean);

      if (includeCustomer && res.errors.some(esErrorDeCustomer)) {
        return {
          kind: 'no-customer-scope',
          detail: `${res.status} ${res.errors.map((e) => e.message).join(' | ').slice(0, 500)}`,
        };
      }

      if (codigos.includes('THROTTLED') && intento < THROTTLE_RETRIES) {
        await esperar(THROTTLE_WAIT_MS * (intento + 1));
        continue;
      }

      return {
        kind: 'failed',
        detail: `${res.status} ${res.errors.map((e) => e.message).join(' | ').slice(0, 500)}`,
      };
    }

    const conexion = res.data?.abandonedCheckouts;
    if (res.status !== 200 || !conexion) {
      return { kind: 'failed', detail: `${res.status}: ${res.bodyText}` };
    }

    return {
      kind: 'ok',
      nodes: conexion.nodes ?? [],
      hasNextPage: conexion.pageInfo?.hasNextPage ?? false,
      endCursor: conexion.pageInfo?.endCursor ?? null,
    };
  }
}

/** ACCESS_DENIED sobre el campo `customer` (falta `read_customers`). */
function esErrorDeCustomer(error: { message?: string; extensions?: { code?: string } }): boolean {
  const code = error.extensions?.code ?? '';
  const msg = error.message ?? '';
  if (code !== 'ACCESS_DENIED') return false;
  return /customer/i.test(msg);
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `gid://shopify/AbandonedCheckout/123` → `"123"`. El webhook de `checkouts/*`
 * guarda el id numérico: acá tiene que quedar el mismo string o se duplican
 * filas contra la única `tenantId_shopifyCheckoutId`. Si el GID no tiene la
 * forma esperada se devuelve tal cual, nunca vacío.
 */
function numericIdFromGid(gid: string): string {
  const match = /\/(\d+)(?:\?.*)?$/.exec(gid);
  return match ? match[1] : gid;
}

/** Traduce un nodo de GraphQL a la forma REST que consume el upsert. */
function normalizeCheckout(node: GqlAbandonedCheckout): NormalizedCheckout {
  const shopMoney = node.totalPriceSet?.shopMoney;
  const presentmentMoney = node.totalPriceSet?.presentmentMoney;

  return {
    id: numericIdFromGid(node.id),
    // `AbandonedCheckout` no expone el token del checkout.
    token: '',
    email: node.customer?.defaultEmailAddress?.emailAddress ?? null,
    phone: node.customer?.defaultPhoneNumber?.phoneNumber ?? null,
    // `total_price` de REST venía en moneda de la tienda, igual que `shopMoney`.
    total_price: shopMoney?.amount ?? '0',
    currency: shopMoney?.currencyCode ?? '',
    presentment_currency: presentmentMoney?.currencyCode ?? '',
    completed_at: node.completedAt ?? null,
    abandoned_checkout_url: node.abandonedCheckoutUrl ?? '',
    line_items: (node.lineItems?.nodes ?? []).map((item) => ({
      title: item.title ?? '',
      quantity: item.quantity ?? 0,
      // `price` de REST era el unitario sin descuentos.
      price: item.originalUnitPriceSet?.shopMoney?.amount ?? '0',
      variant_title: item.variantTitle ?? null,
      sku: item.sku ?? null,
    })),
    shipping_address: normalizeAddress(node.shippingAddress),
    billing_address: normalizeAddress(node.billingAddress),
  };
}

function normalizeAddress(
  address: GqlAddress | null | undefined,
): NormalizedCheckout['shipping_address'] {
  if (!address) return null;
  return {
    first_name: address.firstName ?? '',
    last_name: address.lastName ?? '',
    phone: address.phone ?? null,
  };
}

// normalizePhone imported from @/lib/recover-utils (single source of truth)
