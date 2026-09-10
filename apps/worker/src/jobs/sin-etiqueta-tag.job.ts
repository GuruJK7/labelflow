/**
 * Marca en Shopify los pedidos cuya etiqueta NO se puede imprimir, con el tag
 * "SIN ETIQUETA".
 *
 * POR QUÉ EXISTE. Emitir la guía en DAC y tener la etiqueta imprimible son dos
 * pasos distintos, y el fulfillment de Shopify se dispara con el PRIMERO. Si el
 * segundo falla, el pedido le queda al comerciante como "preparado" mientras el
 * portal muestra "Sin PDF": no puede imprimir, el paquete no sale, y no hay nada
 * que se lo avise. Se entera por el reclamo del comprador, a veces público.
 * Reportado por el dueño de Kinevia y Todo a Mano el 10-09-2026; la causa a
 * escala está documentada en `recuperar-pdfs.ts` (152 etiquetas con guía y sin
 * PDF el 06-09, con Kinevia y Todo a Mano entre los portales afectados).
 *
 * 🔴 POR QUÉ EL PREDICADO **NO** ES `dacGuia != null AND pdfPath IS NULL`.
 * Esa es la trampa de este archivo. `pdf-retention.job.ts` BORRA el PDF y pone
 * `pdfPath = null` a los 15 días (o a los 3 de impreso) a propósito, para no
 * pagar storage, y NO toca el status. O sea que toda etiqueta vieja y
 * perfectamente sana tiene `pdfPath = null`. Con ese predicado le taggearíamos
 * al comerciante miles de pedidos ya entregados y el tag no significaría nada.
 *
 * El discriminador es el STATUS, que retention nunca escribe:
 *   - FAILED / NEEDS_REVIEW + guía real + sin PDF → rota de verdad. Se taggea.
 *   - CREATED / COMPLETED                          → sana. No se taggea, tenga
 *     PDF o no (si no lo tiene, se lo borró retention después de despachar).
 * Es el mismo conjunto que `finalize-recovered-guias.ts` llama "stuck".
 *
 * IDEMPOTENTE Y ACOTADO:
 *   - `addOrderTag` / `removeOrderTag` hacen GET antes y sólo escriben si hay
 *     cambio real: una corrida sobre pedidos ya correctos no toca Shopify.
 *   - Ventana de 30 días: no sale a retro-taggear historia antigua en la primera
 *     corrida.
 *   - Tope por corrida y por tienda; el resto queda para el tick siguiente.
 *   - Para SACAR el tag sólo mira las etiquetas que se recuperaron de verdad
 *     (sanas y con `updatedAt` bastante posterior a `createdAt`), no todas las
 *     sanas: si no, serían miles de GET por hora contra Shopify.
 *
 * NO TOCA NADA DEL DESPACHO: no habla con DAC, no crea envíos, no cambia el
 * fulfillment ni el status de ninguna etiqueta. Sólo lee la tabla Label y
 * escribe un tag.
 */
import { db } from '../db';
import logger from '../logger';
import { createShopifyClient, addOrderTag, removeOrderTag } from '../shopify';
import { resolveShopifyAccessForJob, shopifyTokenSourceForTenant } from '../shopify/access';

export const TAG_SIN_ETIQUETA = 'SIN ETIQUETA';

const INTERVALO_MS = 60 * 60 * 1000; // una vez por hora
const VENTANA_DIAS = 30; // no miramos más atrás que esto
const RECUPERADAS_DIAS = 7; // ventana para sacar el tag
const MAX_POR_TIENDA = 40; // tope por corrida y por tienda
/** Una etiqueta sana cuyo updatedAt es MUCHO posterior al createdAt fue arreglada
 *  después: ésas son las candidatas a destaggear. Una recién creada, no. */
const MARGEN_RECUPERADA_MS = 30 * 60 * 1000;

export interface ResultadoSinEtiqueta {
  taggeados: number;
  destaggeados: number;
  tiendas: number;
  errores: number;
}

export async function runSinEtiquetaTagging(now = new Date()): Promise<ResultadoSinEtiqueta> {
  const res: ResultadoSinEtiqueta = { taggeados: 0, destaggeados: 0, tiendas: 0, errores: 0 };
  const desde = new Date(now.getTime() - VENTANA_DIAS * 24 * 60 * 60 * 1000);
  const desdeRecuperadas = new Date(now.getTime() - RECUPERADAS_DIAS * 24 * 60 * 60 * 1000);

  // Sólo tiendas con Shopify conectado: sin storeUrl no hay a quién taggearle nada.
  const tenants = await db.tenant.findMany({
    where: { shopifyStoreUrl: { not: null } },
    select: { id: true, slug: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  for (const tenant of tenants) {
    if (!tenant.shopifyStoreUrl) continue;

    const rotas = await db.label.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: ['FAILED', 'NEEDS_REVIEW'] },
        dacGuia: { not: null },
        pdfPath: null,
        createdAt: { gte: desde },
      },
      select: { id: true, shopifyOrderId: true, shopifyOrderName: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_POR_TIENDA,
    });

    const sanas = await db.label.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: ['CREATED', 'COMPLETED'] },
        pdfPath: { not: null },
        updatedAt: { gte: desdeRecuperadas },
      },
      select: { id: true, shopifyOrderId: true, shopifyOrderName: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_POR_TIENDA * 2,
    });
    const recuperadas = sanas.filter(
      (l) => l.updatedAt.getTime() - l.createdAt.getTime() > MARGEN_RECUPERADA_MS,
    );

    if (rotas.length === 0 && recuperadas.length === 0) continue;
    res.tiendas += 1;

    let client: ReturnType<typeof createShopifyClient>;
    try {
      const acceso = await resolveShopifyAccessForJob(tenant);
      client = createShopifyClient(
        tenant.shopifyStoreUrl,
        shopifyTokenSourceForTenant(tenant.id, acceso),
        { tenantId: tenant.id, slug: tenant.slug },
      );
    } catch (err) {
      // Una tienda sin token válido no puede frenar a las demás.
      res.errores += 1;
      logger.warn(
        { tenantId: tenant.id, slug: tenant.slug, error: (err as Error).message },
        '[SinEtiqueta] No pude armar el cliente de Shopify; salteo la tienda',
      );
      continue;
    }

    for (const l of rotas) {
      const orderId = Number(l.shopifyOrderId);
      if (!Number.isFinite(orderId)) continue;
      try {
        await addOrderTag(client, orderId, TAG_SIN_ETIQUETA);
        res.taggeados += 1;
      } catch (err) {
        res.errores += 1;
        logger.warn(
          { tenantId: tenant.id, order: l.shopifyOrderName, error: (err as Error).message },
          '[SinEtiqueta] No pude poner el tag',
        );
      }
    }

    for (const l of recuperadas) {
      const orderId = Number(l.shopifyOrderId);
      if (!Number.isFinite(orderId)) continue;
      try {
        if (await removeOrderTag(client, orderId, TAG_SIN_ETIQUETA)) res.destaggeados += 1;
      } catch (err) {
        res.errores += 1;
        logger.warn(
          { tenantId: tenant.id, order: l.shopifyOrderName, error: (err as Error).message },
          '[SinEtiqueta] No pude sacar el tag',
        );
      }
    }
  }

  if (res.taggeados > 0 || res.destaggeados > 0 || res.errores > 0) {
    logger.info(
      { ...res, tag: TAG_SIN_ETIQUETA },
      '[SinEtiqueta] Corrida terminada',
    );
  }
  return res;
}

export function startSinEtiquetaTaggingLoop(): NodeJS.Timeout {
  const t = setInterval(() => {
    runSinEtiquetaTagging().catch((err) =>
      logger.error({ error: (err as Error).message }, '[SinEtiqueta] Loop iteration failed'),
    );
  }, INTERVALO_MS);
  logger.info(
    { intervalMs: INTERVALO_MS, ventanaDias: VENTANA_DIAS, tag: TAG_SIN_ETIQUETA },
    '[SinEtiqueta] Loop started',
  );
  return t;
}
