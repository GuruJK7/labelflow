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
 * Además de esas 7 claves mandamos 3 informativas —`departamento`,
 * `reparto_propio` y `printedAt`— que el consumidor YA declara como opcionales
 * (`PedidoAutoenvia` en wms-mvp/src/app/(app)/picking/actions.ts:278, verificado
 * el 2026-09-01) y que el RPC ignora: `importar_tanda` lee clave por clave con
 * `v_pedido->>'...'` sobre `jsonb_array_elements`, así que una clave de más
 * nunca rompe la importación. DEPO usa `reparto_propio` sólo para contar
 * cuántos pedidos de la tanda son de logística propia y avisarlo en pantalla.
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
 *   - El ORDEN del array es la pila de impresión (`pack_seq` del lado de DEPO).
 *     Se ordena por `packSeq asc nulls last, createdAt asc` — ver ordenarPila().
 *     packSeq describe la pila DEL DÍA, no una impresión suelta: el portal
 *     numera desde `max(packSeq) del día + 1` (ver markClientViewLabelsPrinted
 *     en lib/client-view.ts), así que imprimir el grupo de Maldonado y después
 *     el resto da 1..8 y 9..60 — `zona=todas` los concatena en ese orden, sin
 *     intercalar. Una reimpresión parcial se renumera al final, que es donde
 *     queda el papel.
 *
 * ── "sin_items" ──────────────────────────────────────────────────────────────
 * Las Labels anteriores a esta feature no tienen filas en LabelItem. Mandarlas
 * a DEPO con `items: []` crearía pedidos vacíos que el packer no puede armar.
 * Van en una lista aparte, con el mismo shape, para que el operador las cargue
 * a mano o las ignore — nunca mezcladas con la tanda importable.
 *
 * Desde el 2026-09-01 la ruta intenta ANTES un read-through backfill contra
 * Shopify (lib/wms-items-backfill.ts), así que `sin_items` dejó de significar
 * "vieja" y pasó a significar "ni snapshot ni Shopify pudieron completarla".
 * Este archivo sigue siendo puro: la lista se arma igual, con lo que le llega.
 *
 * ── Zonas ────────────────────────────────────────────────────────────────────
 * `zona` parte la tanda en la pila que reparte LabelFlow (hoy: Maldonado) y la
 * que se va por DAC. El discriminador es el de lib/departamentos.ts (unión de
 * "guía LF-" y "departamento normalizado ∈ propios") — el MISMO que usa el
 * portal para agrupar las etiquetas, así que lo que el operador ve en pantalla
 * y lo que importa en DEPO no pueden discrepar.
 */
import { esRepartoPropio, normalizarDepartamento } from './departamentos';

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
  department: string | null;
  createdAt: Date;
  /** Posición en la pila de la última impresión bulk del portal. Null = nunca. */
  packSeq: number | null;
  /** Cuándo el portal sirvió el PDF por primera vez. Null = sin imprimir. */
  printedAt: Date | null;
  items: WmsExportItemRow[];
}

/** Zonas que el operador puede pedir en `?zona=`. */
export type WmsExportZona = 'maldonado' | 'resto' | 'todas';

export const ZONAS_VALIDAS: readonly WmsExportZona[] = ['maldonado', 'resto', 'todas'];

export function parseZona(valor: string | null | undefined): WmsExportZona | null {
  if (valor === null || valor === undefined || valor === '') return 'todas';
  const v = valor.trim().toLowerCase();
  return (ZONAS_VALIDAS as readonly string[]).includes(v) ? (v as WmsExportZona) : null;
}

/** Ítem tal cual lo consume `importar_tanda`. */
export interface DepoItem {
  sku: string;
  qty: number;
}

/** Pedido tal cual lo consume `importar_tanda` (+ 3 claves informativas). */
export interface DepoPedido {
  cliente: string;
  external_ref: string;
  guia: string | null;
  destinatario: string;
  direccion: string;
  ciudad: string;
  items: DepoItem[];
  /** Departamento NORMALIZADO, o null si el dato de origen no se reconoce. */
  departamento: string | null;
  /** true = la reparte LabelFlow, no DAC. Ver lib/departamentos.ts. */
  reparto_propio: boolean;
  /** ISO 8601 de la primera impresión desde el portal, o null. */
  printedAt: string | null;
}

export interface WmsExportPayload {
  fecha: string;
  cliente: string;
  /** Zona pedida (`todas` por default). Informativa: DEPO no la usa. */
  zona: WmsExportZona;
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
    departamento: normalizarDepartamento(row.department),
    reparto_propio: esRepartoPropio(row),
    printedAt: row.printedAt ? row.printedAt.toISOString() : null,
  };
}

/**
 * Orden de la PILA FÍSICA: `packSeq asc nulls last, createdAt asc`.
 *
 * packSeq lo estampa el portal con el índice del PDF combinado, así que
 * describe el mazo que el operador levanta de la impresora. Las que nunca se
 * imprimieron en bulk (packSeq null) van al FINAL —no al principio— y entre
 * ellas por `createdAt`: si cayeran primero, DEPO le asignaría los pack_seq
 * bajos a etiquetas que no están arriba del mazo y el picking saldría al
 * revés. Ordena una COPIA: la ruta ya pide este mismo orden a Postgres y esto
 * es la red de seguridad (y lo que hace testeable la regla sin base).
 */
export function ordenarPila(rows: WmsExportLabelRow[]): WmsExportLabelRow[] {
  return [...rows].sort((a, b) => {
    const pa = a.packSeq ?? null;
    const pb = b.packSeq ?? null;
    if (pa !== pb) {
      if (pa === null) return 1; // nulls last, en cualquier caso
      if (pb === null) return -1;
      return pa - pb;
    }
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/**
 * ¿Esta fila entra en la zona pedida? `todas` no filtra nada.
 *
 * Genérico para no perder las columnas extra que el caller traiga (la ruta
 * arrastra `shopifyOrderId` para el backfill de ítems): sólo mira `dacGuia` y
 * `department`, que es lo que necesita esRepartoPropio().
 */
export function filtrarZona<T extends Pick<WmsExportLabelRow, 'dacGuia' | 'department'>>(
  rows: T[],
  zona: WmsExportZona,
): T[] {
  if (zona === 'todas') return rows;
  const quiero = zona === 'maldonado';
  return rows.filter((r) => esRepartoPropio(r) === quiero);
}

/**
 * Arma el payload completo del día para un tenant.
 *
 * `rows` tiene que venir ya filtrado por tenant + estado + día. Acá se aplica
 * el filtro de zona y el orden de pila (idempotente respecto del ORDER BY de
 * la consulta).
 */
export function buildWmsExportPayload(
  rows: WmsExportLabelRow[],
  opts: { fecha: string; cliente: string; zona?: WmsExportZona },
): WmsExportPayload {
  const zona = opts.zona ?? 'todas';
  const pedidos: DepoPedido[] = [];
  const sinItems: DepoPedido[] = [];

  for (const row of ordenarPila(filtrarZona(rows, zona))) {
    const pedido = toDepoPedido(row, opts.cliente);
    if (pedido.items.length === 0) sinItems.push(pedido);
    else pedidos.push(pedido);
  }

  return { fecha: opts.fecha, cliente: opts.cliente, zona, pedidos, sin_items: sinItems };
}
