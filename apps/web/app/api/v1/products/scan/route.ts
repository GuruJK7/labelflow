import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import { shopifyGraphql, type GraphqlErrorEntry, type GraphqlResult } from '@/lib/shopify-graphql';

/**
 * Cache entry for one Shopify product. Persisted as `Tenant.productTypeCache`.
 *
 * The worker filter (apps/worker/src/rules/product-filter.ts) matches the
 * tenant's `allowedProductTypes` whitelist against `title`, `type`, AND
 * `vendor`, case-insensitively. So the user can pick a granular product
 * (by title), a category (by type), or a brand (by vendor) — all from
 * the same chip UI.
 *
 * Legacy entries in the DB may still be plain strings (vendor name from
 * pre-2026-04-24 scans). The worker accepts both shapes; the next scan
 * upgrades them to this object shape.
 */
type ProductEntry = {
  title: string;
  type: string;
  vendor: string;
};

type ProductMap = Record<string, ProductEntry>;

/**
 * POST /api/v1/products/scan
 * Scans Shopify and rebuilds the product map.
 * Strategy 1: Products query (needs read_products scope) — title + productType + vendor.
 * Strategy 2: Orders query fallback — title from lineItems.
 *
 * 🔴 OJO CON EL FALLBACK: en REST el `product_id` venía dentro del pedido y
 * alcanzaba con read_orders. En GraphQL el id del producto sale de
 * `lineItem.product`, que EXIGE read_products (verificado contra el esquema
 * 2026-07). O sea: una tienda sin read_products ya no se rescata por pedidos
 * y la ruta termina en el 404 de siempre. No hay campo escalar con el id del
 * producto en LineItem: no es algo que se pueda esquivar acá. El fallback
 * sigue existiendo para el otro caso que cubría (la query de productos falla
 * por algo que no es el scope) y para no cambiar el contrato de `source`.
 *
 * ── GraphQL (requisito 2.2.4 del App Store) ─────────────────────────────────
 * Desde el 1/4/2025 una app pública nueva NO puede tocar recursos REST de
 * productos: esta ruta era el caso que Shopify prohíbe explícitamente y ahora
 * sale entera por la Admin API GraphQL 2026-07 (`lib/shopify-graphql.ts`).
 *
 * 🔴 LAS CLAVES DEL MAPA SIGUEN SIENDO EL ID NUMÉRICO, NO EL GID. El worker
 * resuelve `cache[String(item.product_id)]` con el product_id del pedido
 * (numérico); si acá se guardara `gid://shopify/Product/123`, el filtro de
 * productos dejaría de matchear y todo tenant con whitelist dejaría de
 * despachar, en silencio. Por eso se pide `legacyResourceId` (el ID numérico
 * de siempre) y no `id`.
 */
export async function POST() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify no configurado. Ve a Configuracion para conectar tu tienda.', 400);
  }

  const token = await shopifyAccessForTenant(tenant);
  if (!token) return apiError('Token de Shopify invalido', 400);

  const shop = tenant.shopifyStoreUrl;

  try {
    let map: ProductMap = {};
    let source: 'products' | 'orders' = 'products';

    // ── Strategy 1: Products query ──
    const productsOk = await tryProductsQuery(shop, token, map);

    // ── Strategy 2: Orders query fallback ──
    if (!productsOk) {
      source = 'orders';
      map = {};
      await tryOrdersQuery(shop, token, map);
    }

    if (Object.keys(map).length === 0) {
      return apiError('No se encontraron productos en Shopify. Verifica que tu tienda tenga productos publicados.', 404);
    }

    // Persist enriched map. (Json column — no migration needed.)
    await db.tenant.update({
      where: { id: auth.tenantId },
      data: { productTypeCache: map },
    });

    return apiSuccess({
      ...summarize(map),
      source,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[products/scan] error:', (err as Error).message, (err as Error).stack);
    return apiError('Error escaneando productos', 500);
  }
}

/**
 * GET /api/v1/products/scan
 * Returns cached product map and current filter without calling Shopify.
 */
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { productTypeCache: true, allowedProductTypes: true },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  const map = normalizeCache(tenant.productTypeCache);

  return apiSuccess({
    ...summarize(map),
    allowedProductTypes: (tenant.allowedProductTypes as string[] | null) ?? [],
  });
}

/**
 * Builds the response payload from a (normalized) product map.
 * - `products`: one entry per Shopify product, sorted by title. Used by the
 *   dashboard chip filter so users can pick individual products.
 * - `productTypes`: legacy field kept for the old chip UI — list of unique
 *   non-empty product_type values, sorted.
 * - `vendors`: unique non-empty vendor values, sorted. (Some stores leave
 *   product_type blank but use vendor as the de-facto category.)
 */
function summarize(map: ProductMap) {
  const products = Object.entries(map)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));

  const productTypes = uniqueSorted(Object.values(map).map((p) => p.type));
  const vendors = uniqueSorted(Object.values(map).map((p) => p.vendor));

  return {
    products,
    productTypes,
    vendors,
    totalProducts: products.length,
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].sort(
    (a, b) => a.localeCompare(b, 'es'),
  );
}

/**
 * Coerces both legacy (string) and current (object) cache entries into the
 * enriched ProductEntry shape so callers always get a consistent view.
 */
function normalizeCache(raw: unknown): ProductMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: ProductMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      // Legacy entry — vendor stored as a bare string. Stash it in `vendor`
      // (matches the worker's old fallback) and surface as the title too so
      // the chip UI has something to display until the next scan upgrades it.
      out[id] = { title: value, type: '', vendor: value };
    } else if (value && typeof value === 'object') {
      const v = value as Partial<ProductEntry>;
      out[id] = {
        title: typeof v.title === 'string' ? v.title : '',
        type: typeof v.type === 'string' ? v.type : '',
        vendor: typeof v.vendor === 'string' ? v.vendor : '',
      };
    }
  }
  return out;
}

// ── GraphQL ────────────────────────────────────────────────────────────────
//
// Campos verificados contra la doc 2026-07 (queries/products, objects/Product,
// connections/ProductConnection, queries/orders, objects/LineItem,
// scalars/UnsignedInt64 — `Product.legacyResourceId`).
//
// Costo de query: el tope de una sola query es 1000 puntos (conexión = 2 +
// first × costo del nodo; los escalares no cuentan). Las páginas de acá están
// calculadas para entrar debajo de ese tope y, por las dudas, se achican solas
// si Shopify igual contesta MAX_COST_EXCEEDED.

/** `limit=250` de REST. Costo: 2 + 250 × 1 = 252. */
const PRODUCTS_PAGE = 250;
const PRODUCTS_MIN_PAGE = 25;
/** Corta un bucle de cursores que no termine nunca: 200 × 250 = 50.000 productos. */
const PRODUCTS_MAX_PAGES = 200;

/** Muestra del fallback: mismo tope que el `limit=250` de REST. */
const ORDERS_SAMPLE = 250;
/** Costo por página: 2 + 40 × (1 + 2 + 10 × 2) = 922 < 1000. */
const ORDERS_PAGE = 40;
const ORDERS_LINE_ITEMS = 10;
const ORDERS_MIN_PAGE = 5;
const ORDERS_MIN_LINE_ITEMS = 5;
/**
 * A diferencia de REST (250 pedidos en UNA llamada), GraphQL cobra por página
 * y el balde es de 1000 puntos con reposición de 50/s: barrer 250 pedidos
 * puede tardar más que lo que vive la función. El fallback pagina hasta
 * quedarse sin presupuesto y devuelve lo que juntó — un mapa parcial sirve;
 * un timeout, no.
 */
const ORDERS_BUDGET_MS = 20_000;

const THROTTLE_RETRIES = 3;
const THROTTLE_WAIT_MS = 2_000;

const PRODUCTS_QUERY = `query LabelFlowProductScan($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      legacyResourceId
      title
      productType
      vendor
    }
  }
}`;

/**
 * Sin `query` la conexión `orders` no filtra por estado: es el equivalente del
 * `status=any` de REST (mismo criterio que `getRecentOrders` del worker).
 * `sortKey: CREATED_AT, reverse: true` = los más nuevos primero, que es la
 * muestra que buscaba el `limit=250` de REST.
 */
const ORDERS_QUERY = `query LabelFlowProductScanFromOrders($first: Int!, $after: String, $lineItemsFirst: Int!) {
  orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      lineItems(first: $lineItemsFirst) {
        nodes {
          title
          vendor
          product {
            legacyResourceId
          }
        }
      }
    }
  }
}`;

interface GqlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ProductsData {
  products: {
    pageInfo: GqlPageInfo;
    nodes: Array<{
      legacyResourceId: string;
      title: string | null;
      productType: string | null;
      vendor: string | null;
    }>;
  } | null;
}

interface OrdersData {
  orders: {
    pageInfo: GqlPageInfo;
    nodes: Array<{
      lineItems: {
        nodes: Array<{
          title: string | null;
          vendor: string | null;
          product: { legacyResourceId: string } | null;
        }>;
      } | null;
    }>;
  } | null;
}

/** GraphQL contesta HTTP 200 con `errors[]`: el código vive en extensions.code. */
function hasCode(errors: GraphqlErrorEntry[], code: string): boolean {
  return errors.some((e) => String(e.extensions?.code ?? '') === code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try fetching products from the Products query.
 * Returns true if successful, false if access denied or failed.
 *
 * El contrato de salida es el mismo que tenía la versión REST: false manda al
 * fallback de pedidos (sin read_products, tienda vacía, o cualquier error).
 */
async function tryProductsQuery(
  shop: string,
  token: string,
  map: ProductMap,
): Promise<boolean> {
  try {
    let first = PRODUCTS_PAGE;
    let after: string | null = null;
    let throttleRetries = 0;

    for (let page = 0; page < PRODUCTS_MAX_PAGES; page++) {
      // Anotado a mano: `after` sale del propio resultado y sin el tipo
      // explícito TS no puede cerrar la inferencia circular (TS7022).
      const res: GraphqlResult<ProductsData> = await shopifyGraphql<ProductsData>(
        shop,
        token,
        PRODUCTS_QUERY,
        { first, after },
      );

      // Token revocado / tienda inactiva: Shopify contesta 401/402/403 sin
      // cuerpo GraphQL. Mismo trato que el `res.status === 403 || 401` de REST.
      if (res.status !== 200) return false;

      if (res.errors.length > 0) {
        if (hasCode(res.errors, 'MAX_COST_EXCEEDED') && first > PRODUCTS_MIN_PAGE) {
          first = Math.max(PRODUCTS_MIN_PAGE, Math.floor(first / 2));
          continue;
        }
        if (hasCode(res.errors, 'THROTTLED') && throttleRetries < THROTTLE_RETRIES) {
          throttleRetries++;
          await sleep(THROTTLE_WAIT_MS * throttleRetries);
          continue;
        }
        // ACCESS_DENIED (la tienda no dio read_products) y cualquier otro
        // error: se cae al fallback de pedidos, como hacía el 403 de REST.
        return false;
      }

      const conn: ProductsData['products'] = res.data?.products ?? null;
      if (!conn) return false;

      const nodes = conn.nodes ?? [];
      if (nodes.length === 0 && Object.keys(map).length === 0) return false;

      for (const product of nodes) {
        // 🔴 legacyResourceId, no el GID: es la clave que busca el worker.
        const id = String(product.legacyResourceId ?? '').trim();
        if (!id) continue;
        map[id] = {
          title: (product.title || '').trim(),
          type: (product.productType || '').trim(),
          vendor: (product.vendor || '').trim(),
        };
      }

      if (!conn.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor ?? null;
      if (!after) break;
    }

    return Object.keys(map).length > 0;
  } catch {
    return false;
  }
}

/**
 * Fallback: extract products from recent orders' lineItems.
 * The Orders query doesn't expose productType, so we only get title + vendor
 * here. The worker matcher still works because it ORs across
 * title/type/vendor.
 *
 * 🔴 Necesita read_products igual que la estrategia 1 (ver cabecera del POST):
 * `lineItem.product` está detrás de ese scope. Sin él, Shopify contesta 200
 * con ACCESS_DENIED en `errors[]` y acá se corta con el mapa vacío.
 *
 * Sin try/catch a propósito: un fallo de red acá sube al catch del POST y
 * devuelve 500 «Error escaneando productos», igual que la versión REST.
 */
async function tryOrdersQuery(shop: string, token: string, map: ProductMap): Promise<void> {
  const deadline = Date.now() + ORDERS_BUDGET_MS;
  let first = ORDERS_PAGE;
  let lineItemsFirst = ORDERS_LINE_ITEMS;
  let after: string | null = null;
  let scanned = 0;
  let throttleRetries = 0;

  while (scanned < ORDERS_SAMPLE && Date.now() < deadline) {
    const want = Math.min(first, ORDERS_SAMPLE - scanned);
    // Anotado a mano por el mismo motivo que arriba (TS7022).
    const res: GraphqlResult<OrdersData> = await shopifyGraphql<OrdersData>(
      shop,
      token,
      ORDERS_QUERY,
      { first: want, after, lineItemsFirst },
    );

    if (res.status !== 200) return;

    if (res.errors.length > 0) {
      if (
        hasCode(res.errors, 'MAX_COST_EXCEEDED') &&
        (first > ORDERS_MIN_PAGE || lineItemsFirst > ORDERS_MIN_LINE_ITEMS)
      ) {
        first = Math.max(ORDERS_MIN_PAGE, Math.floor(first / 2));
        lineItemsFirst = Math.max(ORDERS_MIN_LINE_ITEMS, Math.floor(lineItemsFirst / 2));
        continue;
      }
      if (hasCode(res.errors, 'THROTTLED') && throttleRetries < THROTTLE_RETRIES) {
        throttleRetries++;
        await sleep(THROTTLE_WAIT_MS * throttleRetries);
        continue;
      }
      return;
    }

    const conn: OrdersData['orders'] = res.data?.orders ?? null;
    if (!conn) return;

    for (const order of conn.nodes ?? []) {
      scanned++;
      for (const item of order.lineItems?.nodes ?? []) {
        // 🔴 legacyResourceId, no el GID (ver cabecera del POST).
        const key = String(item.product?.legacyResourceId ?? '').trim();
        if (!key) continue; // Producto borrado: no se puede matchear.
        if (map[key]) continue; // First sighting wins.
        map[key] = {
          title: (item.title || '').trim(),
          type: '',
          vendor: (item.vendor || '').trim(),
        };
      }
    }

    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor ?? null;
    if (!after) break;
  }
}
