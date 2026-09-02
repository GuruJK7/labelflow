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
 * ── Reglas de diseño ────────────────────────────────────────────────────────
 *
 *  1. NUNCA rompe el export. Todo lo de Shopify va en try/catch con timeout: si
 *     la Admin API está caída, tiene rate limit o el token no sirve, esas
 *     etiquetas caen a `sin_items` EXACTAMENTE como hoy. Degradación, nunca un
 *     500. El resto del payload (las que sí tienen snapshot) sale igual.
 *
 *  2. Fetch en LOTE. `GET /orders.json?ids=<csv>` trae hasta 250 pedidos por
 *     request; 64 etiquetas = 1 request, no 64. Se corta en lotes de
 *     SHOPIFY_IDS_BATCH y un lote que falla no arrastra a los otros.
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
 *  5. LÍMITE DE 60 DÍAS. El app pide `read_orders`, no `read_all_orders` (ver
 *     REQUIRED_SCOPES en lib/shopify-oauth.ts y shopify.app.toml): la Admin API
 *     sólo devuelve pedidos de los últimos 60 días. Una Label más vieja no
 *     vuelve en la respuesta y queda en `sin_items` para siempre. Para el
 *     problema real (la tanda del día) da igual; si alguna vez hace falta
 *     recuperar histórico profundo, el camino es pedir `read_all_orders` y
 *     re-autorizar la tienda, no cambiar este módulo.
 *
 *  6. Sólo Labels con `shopifyOrderId` numérico. Las de reparto propio (guía
 *     LF-) también nacen de un pedido de Shopify, así que entran igual; lo que
 *     queda afuera es cualquier fila con un id no numérico (semillas, manuales).
 */
import { db } from '@/lib/db';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import type { WmsExportItemRow } from '@/lib/wms-export';

/** Misma versión de la Admin API que usa el resto del repo (worker incluido). */
const SHOPIFY_API_VERSION = '2024-01';

/** `ids` acepta hasta 250 por request; es también el `limit` máximo. */
export const SHOPIFY_IDS_BATCH = 250;

/** Techo de latencia por request a Shopify. Vencido → ese lote cae a sin_items. */
const SHOPIFY_TIMEOUT_MS = 10_000;

/** Tope de etiquetas a recuperar por export. Frena una tanda patológica. */
export const MAX_BACKFILL_LABELS = 1000;

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

interface ShopifyOrderLineItems {
  id: number | string;
  line_items?: ShopifyLineItem[] | null;
}

/** Limpia separadores y espacios redundantes. Igual que el worker y wms-export. */
function clean(value: unknown): string {
  return (value ?? '')
    .toString()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
 * Un lote de ids → Map(orderId → line_items). Tira si Shopify no responde 2xx:
 * el caller decide (y decide siempre lo mismo: seguir sin ese lote).
 */
async function fetchOrdersBatch(
  storeUrl: string,
  token: string,
  ids: string[],
): Promise<Map<string, ShopifyLineItem[]>> {
  const params = new URLSearchParams({
    ids: ids.join(','),
    fields: 'id,line_items',
    limit: String(SHOPIFY_IDS_BATCH),
    status: 'any',
  });
  const url = `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${params}`;

  // AbortController y no sólo el timeout del runtime: un Shopify colgado no
  // puede quedarse con el request del export (DEPO tiene su propio timeout y
  // se lleva un error donde debería llevarse una tanda parcial).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Shopify orders.json respondió ${res.status}`);
    }
    const data = (await res.json()) as { orders?: ShopifyOrderLineItems[] };
    const out = new Map<string, ShopifyLineItem[]>();
    for (const o of data.orders ?? []) {
      out.set(String(o.id), Array.isArray(o.line_items) ? o.line_items : []);
    }
    return out;
  } finally {
    clearTimeout(timer);
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
      const got = await fetchOrdersBatch(storeUrl, token, batch);
      for (const [k, v] of got) lineItemsByOrder.set(k, v);
    } catch {
      // Lote perdido: esas Labels caen a sin_items como hoy. Los otros lotes
      // siguen — media tanda importable es mejor que ninguna.
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
