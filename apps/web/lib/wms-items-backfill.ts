/**
 * Read-through backfill de los ítems del pedido para el export al WMS (DEPO).
 *
 * ── Por qué existe (2026-09-01) ──────────────────────────────────────────────
 * La captura de line_items sobre la fila Label (tabla LabelItem, escrita por
 * apps/worker/src/jobs/label-items.ts) recién existe desde el deploy de HOY
 * 19:19. Todas las Labels anteriores —incluidas las 64 de Kinevia de hoy a la
 * mañana— no tienen ni una fila en LabelItem, así que el export las mandaba a
 * `sin_items` y DEPO importaba CERO pedidos: el operador imprime etiquetas y en
 * el galpón no aparece nada.
 *
 * Este módulo cierra ese agujero SIN backfill offline y sin migración: cuando
 * el export encuentra una Label sin snapshot, va a buscar sus line_items a la
 * Admin API de Shopify del tenant, los devuelve en la respuesta Y los persiste
 * como LabelItem. El export se auto-cura: el costo se paga UNA vez por etiqueta
 * y a partir de ahí la fila sale del snapshot como cualquier otra.
 *
 * ── GraphQL, no REST (2026-09-16) ───────────────────────────────────────────
 * Desde el 1/4/2025 una app pública nueva que consulte recursos REST de
 * productos/pedidos NO pasa la revisión del App Store (requisito 2.2.4). Este
 * módulo usaba `GET /orders.json?ids=<csv>`; ahora usa `nodes(ids: [ID!]!)` con
 * un fragmento `... on Order` sobre el cliente compartido de lib/shopify-graphql.
 * Lo que cambió de forma y por qué está acá abajo, en el docstring de
 * fetchOrdersBatch() y en el de SHOPIFY_IDS_BATCH.
 *
 * ── Reglas de diseño ────────────────────────────────────────────────────────
 *
 *  1. NUNCA rompe el export. Todo lo de Shopify va en try/catch con timeout: si
 *     la Admin API está caída, tiene rate limit o el token no sirve, esas
 *     etiquetas caen a `sin_items` EXACTAMENTE como hoy. Degradación, nunca un
 *     500. El resto del payload (las que sí tienen snapshot) sale igual.
 *
 *  2. Fetch en LOTE. Una query trae SHOPIFY_IDS_BATCH pedidos; 64 etiquetas =
 *     1 request, no 64. Un lote que falla no arrastra a los otros.
 *
 *  3. La persistencia es best-effort y NO condiciona la respuesta. Si el write
 *     falla, los ítems igual se devuelven en este export (el operador puede
 *     trabajar) y el próximo request vuelve a intentar el backfill.
 *
 *  4. Misma FORMA que el worker. `buildLabelItems` + `deleteMany`/`createMany`
 *     por labelId en transacción son una réplica exacta de
 *     apps/worker/src/jobs/label-items.ts. No se importa de ahí porque
 *     apps/worker no entra al build de Next (arrastraría su propio cliente de
 *     Prisma y su config); packages/shared tampoco está en el build de web. Si
 *     alguno de los dos cambia, el otro tiene que cambiar igual — los criterios
 *     están enumerados abajo en el docstring de buildLabelItems().
 *
 *     Ojo: buildLabelItems() sigue recibiendo `{ line_items }` (nombre REST) a
 *     propósito. Es la firma del worker y el contrato de los tests; lo que se
 *     le pasa ahora sale de `Order.lineItems.nodes`, que trae los MISMOS tres
 *     campos (sku/title/quantity) con los mismos tipos.
 *
 *  5. LÍMITE DE 60 DÍAS. El app pide `read_orders`, no `read_all_orders` (ver
 *     REQUIRED_SCOPES en lib/shopify-oauth.ts y shopify.app.toml): la Admin API
 *     sólo devuelve pedidos de los últimos 60 días. Una Label más vieja no
 *     vuelve en la respuesta y queda en `sin_items` para siempre. Para el
 *     problema real (la tanda del día) da igual; si alguna vez hace falta
 *     recuperar histórico profundo, el camino es pedir `read_all_orders` y
 *     re-autorizar la tienda, no cambiar este módulo.
 *
 *     En GraphQL eso puede llegar como un `null` en la lista de `nodes` O como
 *     una entrada en `errors` con los demás nodos resueltos. Por eso el lote se
 *     da por bueno mientras `data.nodes` sea un array: un pedido inaccesible se
 *     saltea, no se lleva puesto al resto del lote.
 *
 *  6. Sólo Labels con `shopifyOrderId` numérico. Las de reparto propio (guía
 *     LF-) también nacen de un pedido de Shopify, así que entran igual; lo que
 *     queda afuera es cualquier fila con un id no numérico (semillas, manuales).
 *     Ese id numérico es el de REST: contra GraphQL se manda como GID y se
 *     vuelve a numérico al leer la respuesta (ver toOrderGid/orderIdFromGid).
 */
import { db } from '@/lib/db';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import {
  shopifyGraphql,
  type GraphqlErrorEntry,
  type GraphqlResult,
} from '@/lib/shopify-graphql';
import type { WmsExportItemRow } from '@/lib/wms-export';

/** Techo de latencia por request a Shopify. Vencido → ese lote cae a sin_items. */
const SHOPIFY_TIMEOUT_MS = 10_000;

/** Tope de etiquetas a recuperar por export. Frena una tanda patológica. */
export const MAX_BACKFILL_LABELS = 1000;

/**
 * Cuántos line_items se piden por pedido en la query de lote.
 *
 * En REST el pedido venía con TODOS sus line_items y no costaba nada extra; en
 * GraphQL `lineItems` es una conexión y cada unidad de `first` se paga en el
 * costo calculado de la query. 10 cubre de sobra el pedido real de estas
 * tiendas; el pedido raro que tenga más se completa con requests de
 * seguimiento (ver fetchRemainingLineItems) — nunca se devuelve a medias.
 */
export const SHOPIFY_LINE_ITEMS_PAGE = 10;

/**
 * Presupuesto de costo calculado por query. Shopify rechaza con
 * MAX_COST_EXCEEDED arriba de 1000; 900 deja margen por si la cuenta cambia
 * entre versiones de la API.
 */
const GRAPHQL_COST_BUDGET = 900;

/**
 * Costo calculado de UN pedido dentro de la query de lote:
 *   1 (el objeto Order) + 2 (la conexión lineItems) + first × 1 (cada LineItem).
 * Los escalares (sku/title/quantity, pageInfo) son gratis.
 */
const GRAPHQL_COST_PER_ORDER = 3 + SHOPIFY_LINE_ITEMS_PAGE;

/**
 * Pedidos por request.
 *
 * ⚠️ Antes eran 250 (el tope del parámetro `ids` de REST, que no costaba nada).
 * GraphQL no limita la cantidad de ids de `nodes()` pero sí el COSTO de la
 * query, así que el lote sale de dividir el presupuesto: 900 / 13 = 69. Con eso
 * la tanda típica (64 etiquetas) sigue siendo UN request, igual que con REST.
 *
 * Si la cuenta de costo de Shopify cambiara y un lote se pasara igual, el lote
 * se parte solo en dos y reintenta (ver fetchOrdersWithCostSplit): esta
 * constante es una optimización, no una condición de correctitud.
 */
export const SHOPIFY_IDS_BATCH = Math.floor(GRAPHQL_COST_BUDGET / GRAPHQL_COST_PER_ORDER);

/** Cuántas veces se puede partir un lote al chocar con MAX_COST_EXCEEDED. */
const MAX_COST_SPLITS = 4;

/**
 * Tope de páginas de seguimiento por pedido. 25 × 10 = 250, que es el máximo de
 * line_items que Shopify admite en un pedido: más que eso es un bug, no un
 * pedido, y se descarta en vez de quedar paginando para siempre.
 */
const MAX_LINE_ITEM_PAGES = 25;

/**
 * Writes en paralelo. Los snapshots son una transacción por labelId (misma
 * forma que el worker), así que 64 etiquetas = 64 idas y vueltas al pooler: en
 * serie eso son varios segundos EN EL REQUEST que el operador está esperando.
 * 8 en vuelo lo baja a ~8 tandas sin abrir más conexiones de las que el pool
 * de la app ya maneja en un pico normal.
 */
const PERSIST_CONCURRENCY = 8;

/** Lo mínimo que el backfill necesita de cada Label. */
export interface BackfillLabelRow {
  id: string;
  shopifyOrderId: string;
  items: WmsExportItemRow[];
}

/**
 * Credenciales del tenant tal cual salen de la tabla (token cifrado). El `id`
 * es para renovar el token bajo demanda si es del App Store (D29).
 */
export interface BackfillTenantCreds {
  id: string;
  shopifyStoreUrl: string | null;
  shopifyToken: string | null;
}

interface ShopifyLineItem {
  sku?: string | null;
  title?: string | null;
  quantity?: number | null;
}

interface GqlLineItemConnection {
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
  nodes?: ShopifyLineItem[] | null;
}

interface GqlOrderNode {
  id?: string | null;
  lineItems?: GqlLineItemConnection | null;
}

interface NodesQueryData {
  nodes?: (GqlOrderNode | null)[] | null;
}

interface OrderPageQueryData {
  order?: GqlOrderNode | null;
}

/**
 * Lote de pedidos por id. `nodes` devuelve `null` en la posición de un id que
 * no resuelve (pedido fuera de la ventana de 60 días, borrado, o de otro tipo):
 * por eso el fragmento `... on Order` y el chequeo de `id` al leer.
 */
const ORDERS_LINE_ITEMS_QUERY = /* GraphQL */ `
  query WmsBackfillOrderLineItems($ids: [ID!]!, $liFirst: Int!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        lineItems(first: $liFirst) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            sku
            title
            quantity
          }
        }
      }
    }
  }
`;

/** Seguimiento para el pedido raro con más de SHOPIFY_LINE_ITEMS_PAGE ítems. */
const ORDER_LINE_ITEMS_PAGE_QUERY = /* GraphQL */ `
  query WmsBackfillOrderLineItemsPage($id: ID!, $liFirst: Int!, $after: String) {
    order(id: $id) {
      id
      lineItems(first: $liFirst, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          sku
          title
          quantity
        }
      }
    }
  }
`;

/** Limpia separadores y espacios redundantes. Igual que el worker y wms-export. */
function clean(value: unknown): string {
  return (value ?? '')
    .toString()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** id numérico (el que guarda la base en `shopifyOrderId`) → GID de GraphQL. */
export function toOrderGid(numericId: string): string {
  return `gid://shopify/Order/${numericId}`;
}

/**
 * GID de GraphQL → id numérico. Es la vuelta de toOrderGid y la única forma de
 * volver a cruzar la respuesta con `Label.shopifyOrderId`, que es numérico: si
 * esto devolviera el GID, NINGUNA etiqueta se completaría (el Map se indexaría
 * con una clave que ninguna fila tiene). Tolera el sufijo `?key=value` que
 * algunos GID traen.
 */
export function orderIdFromGid(gid: unknown): string | null {
  const raw = String(gid ?? '').split('?')[0];
  const m = /\/(\d+)$/.exec(raw);
  return m ? m[1] : null;
}

/** Error de una query de Shopify que conserva el `code` de `errors[].extensions`. */
class ShopifyGraphqlError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = 'ShopifyGraphqlError';
    this.code = code;
  }
}

/** Primer `errors[]` de GraphQL, recortado, para el mensaje del throw. */
function describeErrors(errors: GraphqlErrorEntry[]): { code: string | null; detail: string } {
  const first = errors[0];
  if (!first) return { code: null, detail: '' };
  const code = typeof first.extensions?.code === 'string' ? first.extensions.code : null;
  const msg = clean(first.message).slice(0, 200);
  return { code, detail: `${code ? ` [${code}]` : ''}${msg ? ` ${msg}` : ''}` };
}

/**
 * line_items de Shopify → filas de LabelItem.
 *
 * RÉPLICA EXACTA de buildLabelItems() en apps/worker/src/jobs/label-items.ts.
 * Los criterios (los mismos de allá, para que un pedido backfilleado acá y uno
 * capturado por el worker den filas idénticas):
 *   - cantidad no finita, 0 o negativa → 1 (nunca 0: un ítem con 0 no se empaca),
 *   - cantidad decimal → floor (DAC/WMS trabajan en unidades enteras),
 *   - sku vacío o ausente → null (el export cae a title),
 *   - title vacío pero sku presente → title = sku (title es NOT NULL en la DB),
 *   - ítem sin título NI sku → se descarta: no hay nada que pickear con eso.
 *
 * NO agrupa ni suma: una fila por line_item, tal cual vino. El colapso por sku
 * lo hace toDepoItems() al armar el payload, igual que con el snapshot real.
 */
export function buildLabelItems(
  order: { line_items?: ShopifyLineItem[] | null } | null | undefined,
): WmsExportItemRow[] {
  const items = order?.line_items;
  if (!Array.isArray(items) || items.length === 0) return [];

  const out: WmsExportItemRow[] = [];
  for (const li of items) {
    const sku = clean(li?.sku);
    const title = clean(li?.title);
    if (!sku && !title) continue;

    const q = Number(li?.quantity);
    const quantity = Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;

    out.push({ sku: sku || null, title: title || sku, quantity });
  }
  return out;
}

/** Trocea un array en lotes de a lo sumo `size`. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Las páginas que le faltan a un pedido con más de SHOPIFY_LINE_ITEMS_PAGE
 * ítems. TIRA si no puede completarlo: el caller prefiere dejar ese pedido en
 * `sin_items` antes que exportarlo con ítems de menos — media lista de picking
 * se despacha incompleta y nadie se entera.
 */
async function fetchRemainingLineItems(
  storeUrl: string,
  token: string,
  orderId: string,
  afterCursor: string,
): Promise<ShopifyLineItem[]> {
  const out: ShopifyLineItem[] = [];
  let after: string | null = afterCursor;

  // `res`/`conn` van anotados a mano: sin eso TS no puede inferirlos (el cursor
  // del que dependen se reasigna dentro del mismo loop → TS7022).
  for (let page = 0; page < MAX_LINE_ITEM_PAGES && after; page++) {
    const res: GraphqlResult<OrderPageQueryData> = await shopifyGraphql<OrderPageQueryData>(
      storeUrl,
      token,
      ORDER_LINE_ITEMS_PAGE_QUERY,
      { id: toOrderGid(orderId), liFirst: SHOPIFY_LINE_ITEMS_PAGE, after },
      { timeoutMs: SHOPIFY_TIMEOUT_MS },
    );

    const conn: GqlLineItemConnection | null | undefined = res.data?.order?.lineItems;
    if (res.status !== 200 || !conn || !Array.isArray(conn.nodes)) {
      const { code, detail } = describeErrors(res.errors);
      throw new ShopifyGraphqlError(
        `Shopify GraphQL (line items de ${orderId}) respondió ${res.status}${detail}`,
        code,
      );
    }

    out.push(...conn.nodes);
    after = conn.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
  }

  if (after) {
    throw new ShopifyGraphqlError(
      `El pedido ${orderId} tiene más line items que el tope de paginado`,
      null,
    );
  }
  return out;
}

/**
 * Un lote de ids → Map(orderId NUMÉRICO → line_items). Tira si Shopify no
 * devuelve una lista de nodos usable: el caller decide (y decide siempre lo
 * mismo: seguir sin ese lote).
 *
 * Diferencias de forma contra el `GET /orders.json?ids=` que había acá:
 *   - los ids van como GID y vuelven como GID (se re-numerizan al leer),
 *   - no hace falta `status=any`: buscar por id trae el pedido sea cual sea su
 *     estado, igual que con ese parámetro en REST,
 *   - `fields=id,line_items` desaparece: la selección ES la query,
 *   - GraphQL responde 200 con `errors`. Se toleran los errores PARCIALES
 *     (nodos que no resolvieron) y se corta sólo cuando no vino ninguna lista.
 */
async function fetchOrdersBatch(
  storeUrl: string,
  token: string,
  ids: string[],
): Promise<Map<string, ShopifyLineItem[]>> {
  const res = await shopifyGraphql<NodesQueryData>(
    storeUrl,
    token,
    ORDERS_LINE_ITEMS_QUERY,
    { ids: ids.map(toOrderGid), liFirst: SHOPIFY_LINE_ITEMS_PAGE },
    { timeoutMs: SHOPIFY_TIMEOUT_MS },
  );

  const nodes = res.data?.nodes;
  if (res.status !== 200 || !Array.isArray(nodes)) {
    const { code, detail } = describeErrors(res.errors);
    throw new ShopifyGraphqlError(`Shopify GraphQL respondió ${res.status}${detail}`, code);
  }

  const out = new Map<string, ShopifyLineItem[]>();
  const incompletos: { id: string; after: string }[] = [];

  for (const node of nodes) {
    // `null` (id que no resolvió) o un nodo que no es Order: se saltea, igual
    // que un id ausente en la respuesta de REST.
    const id = orderIdFromGid(node?.id);
    if (!id) continue;

    const conn = node?.lineItems;
    out.set(id, Array.isArray(conn?.nodes) ? conn.nodes : []);

    const cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo?.endCursor : null;
    if (cursor) incompletos.push({ id, after: cursor });
  }

  for (const p of incompletos) {
    try {
      const resto = await fetchRemainingLineItems(storeUrl, token, p.id, p.after);
      out.set(p.id, [...(out.get(p.id) ?? []), ...resto]);
    } catch {
      // Mejor SIN ítems que con ítems incompletos: sin ellos el pedido sale por
      // `sin_items` y se ve; con la mitad, el galpón despacha de menos y nadie
      // lo nota. Se borra del lote y el resto sigue.
      out.delete(p.id);
    }
  }

  return out;
}

/**
 * fetchOrdersBatch con una red: si Shopify rechaza el lote por costo, lo parte
 * en dos y reintenta. Existe para que SHOPIFY_IDS_BATCH (calculado a partir de
 * cómo Shopify cobra HOY) no sea una condición de correctitud: si mañana esa
 * cuenta cambia, el backfill se hace más lento, no se apaga en silencio.
 */
async function fetchOrdersWithCostSplit(
  storeUrl: string,
  token: string,
  ids: string[],
  depth = 0,
): Promise<Map<string, ShopifyLineItem[]>> {
  try {
    return await fetchOrdersBatch(storeUrl, token, ids);
  } catch (err) {
    const porCosto = err instanceof ShopifyGraphqlError && err.code === 'MAX_COST_EXCEEDED';
    if (!porCosto || depth >= MAX_COST_SPLITS || ids.length < 2) throw err;

    const mitad = Math.ceil(ids.length / 2);
    const out = new Map<string, ShopifyLineItem[]>();
    let algunaOk = false;

    for (const parte of [ids.slice(0, mitad), ids.slice(mitad)]) {
      try {
        const got = await fetchOrdersWithCostSplit(storeUrl, token, parte, depth + 1);
        for (const [k, v] of got) out.set(k, v);
        algunaOk = true;
      } catch {
        // Esa mitad se pierde; la otra sigue.
      }
    }

    if (!algunaOk) throw err;
    return out;
  }
}

/**
 * Persiste el snapshot de una Label. Best-effort: devuelve true/false y NUNCA
 * tira. Misma forma que persistLabelItems() del worker: deleteMany + createMany
 * en UNA transacción (un fallo en el medio dejaría la Label sin ítems, que es
 * peor que dejarla con los viejos), e idempotente por labelId — "reemplazar
 * todo el set", no "agregar": si el worker corre después, reescribe lo mismo.
 */
async function persistOne(labelId: string, items: WmsExportItemRow[]): Promise<boolean> {
  try {
    await db.$transaction([
      db.labelItem.deleteMany({ where: { labelId } }),
      db.labelItem.createMany({
        data: items.map((it) => ({
          labelId,
          sku: it.sku,
          title: it.title,
          quantity: it.quantity,
        })),
      }),
    ]);
    return true;
  } catch {
    // Silencioso a propósito: los ítems ya están en la respuesta y el próximo
    // export reintenta. Un throw acá convertiría una mejora en una caída.
    return false;
  }
}

export interface BackfillResult {
  /** labelId → ítems recuperados de Shopify. Sólo las que se pudieron completar. */
  items: Map<string, WmsExportItemRow[]>;
  /** Cuántas Labels entraron al intento (sin snapshot y con id numérico). */
  intentadas: number;
  /** Cuántas se completaron con ítems reales. */
  recuperadas: number;
  /** Cuántas de esas quedaron persistidas como LabelItem. */
  persistidas: number;
  /** Por qué no se intentó nada, cuando corresponde. */
  skipped?: 'nada-que-hacer' | 'sin-credenciales' | 'token-ilegible';
}

const VACIO = (skipped?: BackfillResult['skipped']): BackfillResult => ({
  items: new Map(),
  intentadas: 0,
  recuperadas: 0,
  persistidas: 0,
  ...(skipped ? { skipped } : {}),
});

/**
 * Completa desde Shopify los ítems de las Labels que no tienen snapshot y los
 * deja persistidos para la próxima.
 *
 * Devuelve SÓLO lo recuperado (el caller mergea): las Labels que ya traían
 * ítems no se tocan y no generan ni un request. Nunca tira.
 */
export async function backfillMissingItems(
  rows: BackfillLabelRow[],
  tenant: BackfillTenantCreds,
): Promise<BackfillResult> {
  // 1. ¿Hay algo que completar? Sin esto, un tenant al día pagaría un decrypt
  //    y cero requests igual; con esto no toca nada.
  const faltantes = rows.filter(
    (r) => (r.items?.length ?? 0) === 0 && /^\d+$/.test((r.shopifyOrderId ?? '').trim()),
  );
  if (faltantes.length === 0) return VACIO('nada-que-hacer');

  // 2. Credenciales. Un tenant sin tienda conectada no es un error: es un
  //    tenant sin fallback posible. Se sale como si no hubiera nada que hacer.
  const storeUrl = clean(tenant?.shopifyStoreUrl);
  if (!storeUrl || !tenant?.shopifyToken) return VACIO('sin-credenciales');
  const token = await shopifyAccessForTenant(tenant);
  if (!token) return VACIO('token-ilegible');

  const acotadas = faltantes.slice(0, MAX_BACKFILL_LABELS);

  // 3. Ids únicos: dos Labels pueden colgar del mismo pedido (envío partido) y
  //    no tiene sentido pedirlo dos veces.
  const ids = Array.from(new Set(acotadas.map((r) => r.shopifyOrderId.trim())));

  const lineItemsByOrder = new Map<string, ShopifyLineItem[]>();
  for (const batch of chunk(ids, SHOPIFY_IDS_BATCH)) {
    try {
      const got = await fetchOrdersWithCostSplit(storeUrl, token, batch);
      for (const [k, v] of got) lineItemsByOrder.set(k, v);
    } catch (err) {
      // Lote perdido: esas Labels caen a sin_items como hoy. Los otros lotes
      // siguen — media tanda importable es mejor que ninguna. Se loguea porque
      // un backfill apagado es invisible desde el payload (todo sale por
      // `sin_items`, que es exactamente el bug que este módulo vino a tapar).
      console.warn('[wms/backfill] lote de Shopify perdido', {
        tenantId: tenant.id,
        pedidos: batch.length,
        message: clean((err as { message?: unknown })?.message).slice(0, 200),
      });
    }
  }

  // 4. Mapear + persistir. La escritura va después de tener TODO mapeado para
  //    que un write lento no retrase el armado de la respuesta de los demás.
  const items = new Map<string, WmsExportItemRow[]>();
  const aEscribir: { labelId: string; items: WmsExportItemRow[] }[] = [];
  for (const row of acotadas) {
    const li = lineItemsByOrder.get(row.shopifyOrderId.trim());
    if (!li) continue;
    const built = buildLabelItems({ line_items: li });
    if (built.length === 0) continue; // pedido real sin nada pickeable
    items.set(row.id, built);
    aEscribir.push({ labelId: row.id, items: built });
  }

  let persistidas = 0;
  for (const tanda of chunk(aEscribir, PERSIST_CONCURRENCY)) {
    const oks = await Promise.all(tanda.map((w) => persistOne(w.labelId, w.items)));
    persistidas += oks.filter(Boolean).length;
  }

  return {
    items,
    intentadas: acotadas.length,
    recuperadas: items.size,
    persistidas,
  };
}

/**
 * Aplica el resultado del backfill sobre las filas del export, sin mutar la
 * entrada: devuelve copias sólo de las filas que cambiaron.
 */
export function applyBackfilledItems<T extends BackfillLabelRow>(
  rows: T[],
  recuperados: Map<string, WmsExportItemRow[]>,
): T[] {
  if (recuperados.size === 0) return rows;
  return rows.map((r) => {
    const items = recuperados.get(r.id);
    return items ? { ...r, items } : r;
  });
}
