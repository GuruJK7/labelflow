import type { AxiosInstance } from 'axios';
import { db } from '../db';
import type { ShopifyOrder } from '../shopify/types';
import { fulfillOrderWithTracking, ShopifyAlreadyFulfilledError, ShopifyMissingScopesError } from '../shopify/fulfillment';
import { markOrderProcessed, addOrderNote } from '../shopify/orders';
import { uploadLabelPdf } from '../storage/upload';
import { buildSafeLabelGeoFields } from '../jobs/label-safe-fields';
import { persistLabelItems } from '../jobs/label-items';
import { mergeAddress } from '../dac/shipment';
import { codigoSeguimiento } from './tracking';
import { renderEtiquetaPdf } from './render';
import type { VeredictoZona } from './zone';

/**
 * Pipeline de los pedidos que se reparten sin DAC.
 *
 * Es el espejo del tramo (c)…(f) de process-orders.job.ts, pero SIN los pasos
 * que dependen de DAC: no hay login, no hay navegador de DAC, no hay guia y no
 * se descuenta credito (el credito representa un envio despachado por DAC; aca
 * no hay ninguno).
 *
 * Deliberadamente NO importa nada de dac/shipment.ts salvo mergeAddress, que es
 * un helper de texto puro. La automatizacion de DAC no se toca ni se lee: estos
 * pedidos jamas entran en ese camino.
 *
 * Lo que SI comparte con el flujo normal, para que el dashboard y Shopify se
 * vean igual venga por donde venga el envio:
 *   - fila en Label (con dacGuia = "LF-…", status COMPLETED, pdfUrl)
 *   - PDF en el mismo bucket y con la misma convencion de path
 *   - fulfillment en Shopify (sin link de rastreo de DAC) + tag de procesado
 */

export interface CtxRepartoPropio {
  tenantId: string;
  jobId: string;
  /** Nombre que va como remitente en la etiqueta. */
  nombreTienda: string;
  shopifyClient: AxiosInstance;
  /** En testMode no se toca Shopify ni se sube nada. */
  testMode: boolean;
  /** Si el tenant tiene el fulfillment apagado, no marcamos preparado. */
  debeFulfillear: boolean;
  forceAll: boolean;
  log: {
    info: (paso: string, msg: string, meta?: unknown) => void;
    warn: (paso: string, msg: string, meta?: unknown) => void;
    error: (paso: string, msg: string, meta?: unknown) => void;
    success: (paso: string, msg: string, meta?: unknown) => void;
  };
}

export interface ResultadoRepartoPropio {
  procesados: number;
  fallidos: number;
  codigos: string[];
}

/** Nota que queda en el pedido de Shopify para que se entienda por que no hay guia DAC. */
const notaShopify = (codigo: string, depto: string) =>
  `LabelFlow: reparto propio (${depto}) — etiqueta ${codigo}. No se generó guía DAC.`;

export async function procesarPedidosRepartoPropio(
  pedidos: Array<{ order: ShopifyOrder; veredicto: VeredictoZona }>,
  ctx: CtxRepartoPropio,
): Promise<ResultadoRepartoPropio> {
  const salida: ResultadoRepartoPropio = { procesados: 0, fallidos: 0, codigos: [] };

  for (const { order, veredicto } of pedidos) {
    const addr = order.shipping_address;
    if (!addr) {
      // Mismo criterio que el flujo DAC: sin direccion no hay nada que hacer.
      ctx.log.error('reparto-propio', `Pedido ${order.name} sin dirección de envío — se omite`);
      salida.fallidos++;
      continue;
    }

    const codigo = codigoSeguimiento(ctx.tenantId, String(order.id));
    // mergeAddress separa la calle (fullAddress) de los datos de acceso —
    // apartamento, porteria, referencias — que en DAC van al campo
    // "Observaciones". La etiqueta propia no tiene ese campo aparte, asi que
    // extraObs se muestra en la nota: sin eso el "Apto 3" se pierde y el
    // repartidor se queda en la puerta del edificio.
    const { fullAddress, extraObs } = mergeAddress(addr.address1, addr.address2);
    const { safeCity, safeDepartment } = buildSafeLabelGeoFields({
      city: addr.city,
      province: addr.province,
      resolvedDepartment: veredicto.departamento,
    });

    const nombreCliente = [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim()
      || order.email
      || 'Sin nombre';

    try {
      // ── 1. Fila en Label. Se hace ANTES de generar el PDF para que, si el
      // render falla, el pedido quede visible como FAILED en el dashboard y no
      // desaparezca en silencio.
      const label = await db.label.upsert({
        where: { tenantId_shopifyOrderId: { tenantId: ctx.tenantId, shopifyOrderId: String(order.id) } },
        create: {
          tenantId: ctx.tenantId,
          jobId: ctx.jobId,
          shopifyOrderId: String(order.id),
          shopifyOrderName: order.name,
          customerName: nombreCliente,
          customerEmail: order.email || null,
          customerPhone: addr.phone || order.phone || null,
          deliveryAddress: fullAddress,
          city: safeCity,
          department: safeDepartment,
          totalUyu: Number(order.total_price) || 0,
          // El envio no lo cobra DAC: no hay remitente/destinatario que pague
          // flete. Se deja DESTINATARIO (el default del modelo) por compatibilidad
          // con el dashboard, y paymentStatus deja claro que no aplica.
          paymentType: 'DESTINATARIO',
          paymentStatus: 'not_required',
          dacGuia: codigo,
          status: 'PENDING',
        },
        update: {
          jobId: ctx.jobId,
          dacGuia: codigo,
          status: 'PENDING',
          errorMessage: null,
          deliveryAddress: fullAddress,
          city: safeCity,
          department: safeDepartment,
        },
      });

      // ── 1.5. Snapshot de ítems del pedido para el export al WMS.
      // Best-effort (nunca tira): el reparto propio también entra a la tanda
      // del día, y el packer necesita saber qué va adentro de la caja.
      await persistLabelItems(label.id, order, ctx.log);

      // ── 2. Etiqueta PDF.
      const pdf = await renderEtiquetaPdf({
        codigo,
        remitente: ctx.nombreTienda,
        destinatario: {
          nombre: nombreCliente,
          direccion: fullAddress,
          ciudad: safeCity,
          departamento: safeDepartment,
          telefono: addr.phone || order.phone || null,
        },
        pedido: { nombre: order.name, fecha: new Date() },
        // El worker solo recibe pedidos con financial_status=paid
        // (ver getUnfulfilledOrders), asi que no hay nada que cobrar al entregar.
        cobrarUyu: null,
        nota: [extraObs, order.note].map((x) => (x ?? '').trim()).filter(Boolean).join(' · ') || null,
      });

      let pdfPath: string | null = null;
      if (!ctx.testMode) {
        const up = await uploadLabelPdf(ctx.tenantId, label.id, pdf);
        if (up.error) {
          ctx.log.warn('reparto-propio', `Etiqueta de ${order.name} generada pero no se pudo subir: ${up.error}`);
        } else {
          pdfPath = up.path;
        }
      }

      await db.label.update({
        where: { id: label.id },
        data: { status: 'COMPLETED', pdfPath, pdfUrl: pdfPath },
      });

      ctx.log.success('reparto-propio', `Etiqueta propia emitida para ${order.name}`, {
        codigo, departamento: safeDepartment, motivo: veredicto.motivo,
      });

      // ── 3. Shopify: preparado + tag + nota.
      if (!ctx.testMode && ctx.debeFulfillear) {
        try {
          await fulfillOrderWithTracking(
            ctx.shopifyClient, order.id, codigo, undefined, ctx.forceAll,
            // Sin URL: este envio no esta en DAC y un link de rastreo de DAC
            // le llegaria roto al cliente por mail.
            { company: 'Reparto propio', sinUrl: true },
          );
        } catch (err) {
          if (err instanceof ShopifyAlreadyFulfilledError) {
            ctx.log.info('reparto-propio', `${order.name} ya estaba preparado en Shopify — no lo toco`);
          } else if (err instanceof ShopifyMissingScopesError) {
            ctx.log.error('reparto-propio', `Shopify CONFIG ERROR: ${err.message}`);
          } else {
            ctx.log.warn('reparto-propio', `No se pudo marcar preparado ${order.name}: ${(err as Error).message}`);
          }
        }
      }

      if (!ctx.testMode) {
        await markOrderProcessed(ctx.shopifyClient, order.id, codigo).catch((e) =>
          ctx.log.warn('reparto-propio', `No se pudo etiquetar ${order.name} en Shopify: ${(e as Error).message}`),
        );
        await addOrderNote(ctx.shopifyClient, order.id, notaShopify(codigo, safeDepartment)).catch(() => {});
      }

      salida.procesados++;
      salida.codigos.push(codigo);
    } catch (err) {
      salida.fallidos++;
      ctx.log.error('reparto-propio', `Falló la etiqueta propia de ${order.name}: ${(err as Error).message}`);
      await db.label
        .updateMany({
          where: { tenantId: ctx.tenantId, shopifyOrderId: String(order.id) },
          data: { status: 'FAILED', errorMessage: `reparto propio: ${(err as Error).message}`.slice(0, 500) },
        })
        .catch(() => {});
    }
  }

  return salida;
}
