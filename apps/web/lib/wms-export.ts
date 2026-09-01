/**
 * Export de la tanda del día al WMS (DEPO) — armado del payload.
 *
 * Este archivo es PURO: sin Prisma, sin next/server, sin I/O. Todo lo que hace
 * es (a) resolver los bordes del día LOCAL uruguayo y (b) mapear filas de Label
 * al contrato que DEPO ya tiene congelado. La ruta
 * (app/api/v1/wms/export/route.ts) sólo se encarga de auth + query.
 *
 * ── Contrato del consumidor ──────────────────────────────────────────────────
 * DEPO importa la tanda con el RPC `importar_tanda(p_fecha, p_source,
 * p_pedidos)`. Cada elemento de `p_pedidos` es EXACTAMENTE:
 *
 *   { "cliente": "Alba Textil", "external_ref": "#1042", "guia": "AB123456789",
 *     "destinatario": "Juan Pérez", "direccion": "Av. Italia 1234 apto 5",
 *     "ciudad": "Montevideo", "items": [ { "sku": "REM-001", "qty": 2 } ] }
 *
 * Detalles del contrato que NO se pueden cambiar de este lado:
 *   - `cliente` se matchea por nombre EXACTO (btrim) contra la tabla `clients`
 *     de DEPO. Si el nombre del tenant en LabelFlow no coincide con el de la
 *     tienda en DEPO, el pedido se salta con motivo `cliente_desconocido`. Es
 *     un dato de configuración de DEPO, no un bug de este export.
 *   - `external_ref` es la clave de dedup (client_id, external_ref) → re-importar
 *     la misma tanda es idempotente. Usamos `shopifyOrderName` (el "#1042" que
 *     el operador ve), NO el cuid interno: si mañana hay que reconciliar a mano
 *     contra Shopify, el nombre del pedido es lo único legible en los dos lados.
 *   - `items[].sku` se resuelve contra products(client_id, sku) y después contra
 *     product_aliases. Por eso cuando el ítem no tiene sku mandamos el TÍTULO:
 *     DEPO lo mapea una vez como alias y queda aprendido.
 *   - El ORDEN del array es la pila de impresión (`pack_seq`). Acá se ordena por
 *     `createdAt` ascendente, que es el orden en que el worker generó las
 *     etiquetas. ⚠️ Si el portal imprime el PDF bulk en otro orden, la pila
 *     física no va a coincidir con `pack_seq`. Registrar el orden real del
 *     último bulk print quedó FUERA de esta entrega (ver reporte).
 *
 * ── "sin_items" ──────────────────────────────────────────────────────────────
 * Las Labels anteriores a esta feature no tienen filas en LabelItem. Mandarlas
 * a DEPO con `items: []` crearía pedidos vacíos que el packer no puede armar.
 * Van en una lista aparte, con el mismo shape, para que el operador las cargue
 * a mano o las ignore — nunca mezcladas con la tanda importable.
 */

/** Uruguay es UTC-3 fijo (sin DST desde 2015). Mismo criterio que lib/uy-time.ts. */
const UY_OFFSET_MS = 3 * 60 * 60 * 1000;

export const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface WmsExportItemRow {
  sku: string | null;
  title: string;
  quantity: number;
}

/** Forma mínima de Label que el export necesita (lo que selecciona la ruta). */
export interface WmsExportLabelRow {
  id: string;
  shopifyOrderName: string;
  dacGuia: string | null;
  customerName: string;
  deliveryAddress: string;
  city: string;
  createdAt: Date;
  items: WmsExportItemRow[];
}

/** Ítem tal cual lo consume `importar_tanda`. */
export interface DepoItem {
  sku: string;
  qty: number;
}

/** Pedido tal cual lo consume `importar_tanda`. */
export interface DepoPedido {
  cliente: string;
  external_ref: string;
  guia: string | null;
  destinatario: string;
  direccion: string;
  ciudad: string;
  items: DepoItem[];
}

export interface WmsExportPayload {
  fecha: string;
  cliente: string;
  /** Listos para pegar en `importar_tanda`, en orden de pila. */
  pedidos: DepoPedido[];
  /** Labels del día SIN snapshot de ítems (históricos). Mismo shape, items vacío. */
  sin_items: DepoPedido[];
}

/**
 * Valida un `YYYY-MM-DD` y devuelve sus partes. Null si no es una fecha real
 * (rechaza "2026-13-40" además del formato).
 */
export function parseYmd(ymd: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!ymd || !YMD_REGEX.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Round-trip: descarta 2026-02-31 y compañía.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/**
 * Bordes UTC del día LOCAL uruguayo `ymd`: [00:00 UY, 00:00 UY del día siguiente).
 *
 * El worker corre en UTC (Render) y `Label.createdAt` se guarda en UTC. Filtrar
 * por el día calendario UTC perdería todos los envíos generados entre las 21:00
 * y la medianoche de Uruguay — que es justo la ventana en la que se cierra la
 * tanda del día. Por eso el rango se corre 3 horas.
 */
export function uyDayRange(ymd: string): { gte: Date; lt: Date } | null {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  const startUtcMs = Date.UTC(parts.y, parts.m - 1, parts.d) + UY_OFFSET_MS;
  return {
    gte: new Date(startUtcMs),
    lt: new Date(startUtcMs + 24 * 60 * 60 * 1000),
  };
}

/** `YYYY-MM-DD` del día uruguayo que contiene `now`. Default para `?date=`. */
export function uyToday(now: Date = new Date()): string {
  const uyClock = new Date(now.getTime() - UY_OFFSET_MS);
  const y = uyClock.getUTCFullYear();
  const m = String(uyClock.getUTCMonth() + 1).padStart(2, '0');
  const d = String(uyClock.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function clean(value: unknown): string {
  return (value ?? '').toString().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Colapsa los ítems de una Label al shape de DEPO.
 *
 * - sku vacío/null → cae al título (DEPO lo resuelve por alias).
 * - ítems repetidos del mismo sku se SUMAN acá además de en el RPC: el snapshot
 *   guarda una fila por line_item y un pedido con el mismo producto en dos
 *   líneas tiene que llegar como una sola línea con la cantidad total, sino el
 *   packer ve el mismo producto dos veces y cree que se equivocó.
 * - qty no positiva → 1 (nunca 0: un ítem con 0 no se empaca nunca).
 */
export function toDepoItems(items: WmsExportItemRow[]): DepoItem[] {
  const order: string[] = [];
  const qtyBySku = new Map<string, number>();
  for (const it of items ?? []) {
    const sku = clean(it?.sku) || clean(it?.title);
    if (!sku) continue;
    const q = Number(it?.quantity);
    const qty = Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
    if (!qtyBySku.has(sku)) order.push(sku);
    qtyBySku.set(sku, (qtyBySku.get(sku) ?? 0) + qty);
  }
  return order.map((sku) => ({ sku, qty: qtyBySku.get(sku) as number }));
}

/** Mapea una Label al pedido de DEPO (sin decidir todavía en qué lista va). */
export function toDepoPedido(row: WmsExportLabelRow, cliente: string): DepoPedido {
  return {
    cliente,
    external_ref: clean(row.shopifyOrderName),
    guia: clean(row.dacGuia) || null,
    destinatario: clean(row.customerName),
    direccion: clean(row.deliveryAddress),
    ciudad: clean(row.city),
    items: toDepoItems(row.items ?? []),
  };
}

/**
 * Arma el payload completo del día para un tenant.
 *
 * `rows` tiene que venir ya filtrado por tenant + estado + día. El orden de
 * entrada se respeta tal cual (es la pila de impresión).
 */
export function buildWmsExportPayload(
  rows: WmsExportLabelRow[],
  opts: { fecha: string; cliente: string },
): WmsExportPayload {
  const pedidos: DepoPedido[] = [];
  const sinItems: DepoPedido[] = [];

  for (const row of rows) {
    const pedido = toDepoPedido(row, opts.cliente);
    if (pedido.items.length === 0) sinItems.push(pedido);
    else pedidos.push(pedido);
  }

  return { fecha: opts.fecha, cliente: opts.cliente, pedidos, sin_items: sinItems };
}
