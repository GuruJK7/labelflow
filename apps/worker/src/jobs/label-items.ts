/**
 * Snapshot de los ítems del pedido sobre la fila Label (tabla LabelItem).
 *
 * Por qué existe (2026-09-01): el WMS (DEPO) importa la tanda del día y para
 * el picking/packing necesita QUÉ productos van en cada envío. Hasta ahora los
 * line_items del pedido sólo existían en memoria durante el ciclo del worker
 * (se usaban para la línea de observaciones de DAC y se descartaban). Este
 * módulo los persiste en el mismo punto donde ya se crea/actualiza la Label.
 *
 * REGLAS DE DISEÑO — importan porque esto corre en el camino de envíos reales:
 *
 *  1. NUNCA tira. Un fallo escribiendo el snapshot no puede voltear un envío
 *     que YA tiene guía de DAC emitida. Todo va envuelto en try/catch y a lo
 *     sumo deja un warn. Esto también hace el deploy seguro en cualquier orden:
 *     si el código sale antes que la tabla, se pierden snapshots pero no envíos.
 *
 *  2. Es idempotente por labelId. Las Labels se hacen upsert (los reintentos de
 *     una FAILED reescriben la misma fila), así que la escritura es
 *     "reemplazar todo el set", no "agregar". Sin eso, un pedido reintentado
 *     tres veces mandaría al WMS el triple de unidades.
 *
 *  3. NO agrupa ni suma. Guarda una fila por line_item, tal cual vino. El
 *     consumidor (RPC importar_tanda de DEPO) ya suma los ítems repetidos del
 *     mismo sku; agrupar acá sólo destruiría información del snapshot.
 *
 *  4. NO toca nada de dac/. Lee el mismo `order` que el resto del job.
 */
import { db } from '../db';
import type { ShopifyOrder } from '../shopify/types';

export interface LabelItemSnapshot {
  sku: string | null;
  title: string;
  quantity: number;
}

/** Limpia separadores y espacios redundantes de un campo de texto del pedido. */
function clean(value: unknown): string {
  return (value ?? '')
    .toString()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convierte los line_items del pedido en filas de LabelItem.
 *
 * Función PURA (sin I/O) para poder testear los bordes sin base.
 *
 * Criterios (mismos que buildSkuObservationLine donde aplica, para que el
 * snapshot y el texto que ve el operador en DAC no se contradigan):
 *   - cantidad no finita, 0 o negativa → 1 (nunca 0: un ítem del pedido es al
 *     menos una unidad; un 0 en el WMS haría que el packer no empaque nada).
 *   - cantidad decimal → floor (DAC/WMS trabajan con unidades enteras).
 *   - sku vacío o ausente → null (el export cae a title).
 *   - title vacío pero sku presente → title = sku (title es NOT NULL en la DB).
 *   - ítem sin título NI sku → se descarta: no hay nada que pickear con eso.
 */
export function buildLabelItems(
  order: Pick<ShopifyOrder, 'line_items'> | null | undefined,
): LabelItemSnapshot[] {
  const items = order?.line_items;
  if (!Array.isArray(items) || items.length === 0) return [];

  const out: LabelItemSnapshot[] = [];
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

/**
 * Persiste el snapshot de ítems de un pedido sobre su Label.
 *
 * Best-effort: devuelve la cantidad de filas escritas, 0 si no había nada que
 * guardar o si la escritura falló. NUNCA tira.
 *
 * `log` es opcional para no acoplar esto al slog de cada job.
 */
export async function persistLabelItems(
  labelId: string,
  order: Pick<ShopifyOrder, 'line_items'> | null | undefined,
  log?: { warn: (step: string, msg: string, meta?: Record<string, unknown>) => void },
): Promise<number> {
  try {
    const items = buildLabelItems(order);
    if (items.length === 0) return 0;

    // Transacción: el delete + create tienen que ser atómicos, sino un fallo en
    // el medio deja la Label sin ítems (peor que dejarla con los viejos).
    await db.$transaction([
      db.labelItem.deleteMany({ where: { labelId } }),
      db.labelItem.createMany({
        data: items.map((it) => ({ labelId, sku: it.sku, title: it.title, quantity: it.quantity })),
      }),
    ]);
    return items.length;
  } catch (err) {
    log?.warn('label-items', `No se pudo guardar el detalle de ítems: ${(err as Error).message}`, {
      labelId,
    });
    return 0;
  }
}
