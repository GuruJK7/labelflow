import { db } from '../db';
import type { ShopifyClient } from '../shopify';
import {
  addOrderNote,
  fulfillOrderWithTracking,
  markOrderProcessed,
  ShopifyAlreadyFulfilledError,
  ShopifyMissingScopesError,
} from '../shopify';
import type { ShopifyOrder } from '../shopify/types';
import { uploadLabelPdf } from '../storage/upload';
import { buildSafeLabelGeoFields } from '../jobs/label-safe-fields';
import { persistLabelItems } from '../jobs/label-items';
import { mergeAddress } from '../dac/shipment';
import { cargaMasiva, obtenerLocalidadesCorreo, type CorreoAmbiente } from './client';
import { pedidoDesdeOrden, type ConfigCorreoTienda, type ExtrasPedido } from './adapter';
import { construirEnvio } from './validate';
import { urlSeguimientoComprador } from './tracking';
import { CorreoError, type CorreoCredenciales, type LocalidadCorreo } from './types';
import { nombreTransportista, transportistaDe } from '../transportista';
import { shadowRecordShipment } from '../billing/shadow';

/**
 * Despacho de los pedidos que salen por Correo Uruguayo (plataforma AHIVA).
 *
 * Es el espejo del tramo (c)…(f) de process-orders.job.ts, pero contra la API
 * SOAP de Correo en vez del formulario de DAC: no hay login, no hay navegador,
 * no hay CAPTCHA. `cargaMasiva` crea el envío y devuelve el código de
 * trazabilidad Y la etiqueta en PDF en la misma respuesta.
 *
 * NO importa nada de `dac/` salvo dos helpers de texto puro (`mergeAddress`) y
 * geografía (vía `oficina.ts`). La automatización de DAC no se toca ni se
 * modifica: un pedido que entra acá jamás pasa por ese camino.
 *
 * AGNÓSTICO DE LA FUENTE: recibe `ShopifyOrder`, que es la forma a la que
 * normalizan las tres fuentes (Shopify, panel y carga masiva por Excel).
 *
 * ── LAS DOS DIFERENCIAS QUE NO SON COSMÉTICAS FRENTE A DAC ──
 *
 * 1. IDEMPOTENCIA ANTES DE LA LLAMADA. Correo NO tiene consulta de envíos por
 *    referencia: verificado contra los WSDL de ConsultarEstadosService e
 *    ImpresionServicev2, todo se consulta por código de trazabilidad. O sea que
 *    si el proceso muere entre "AHIVA creó el envío" y "lo guardamos", no hay
 *    forma de preguntarle a Correo si existe. Por eso se escribe una fila en
 *    PendingShipment ANTES de llamar, y una fila pendiente BLOQUEA el reintento
 *    automático. Con DAC ese caso se reconcilia solo (orphan-reconcile lee el
 *    portal); acá no se puede, y un reintento a ciegas es una segunda guía real
 *    facturada y una segunda mercadería a cobrar.
 *
 * 2. SI EL PDF NO SE PUDO GUARDAR, EL ENVÍO NO SE DA POR DESPACHADO. El envío ya
 *    existe y ya se facturó, así que el código se guarda igual — pero la
 *    etiqueta queda en NEEDS_REVIEW y NO se marca preparado en Shopify. Es lo
 *    contrario de lo que hace hoy reparto propio (self-delivery/process.ts:161-174
 *    marca COMPLETED con pdfPath null y fulfillea igual, dejando un pedido
 *    "despachado" sin etiqueta imprimible). Con Correo esto es recuperable: la
 *    etiqueta se vuelve a pedir con `impresionEtiquetas` usando el código.
 */

export interface CtxCorreo {
  tenantId: string;
  jobId: string;
  /**
   * Cliente de Shopify. `null` para las fuentes que no viven en Shopify (el
   * panel y la carga por Excel): ahí no hay pedido que marcar preparado ni
   * tienda a la que etiquetar, y llamar igual sería un error por cada pedido.
   */
  shopifyClient: ShopifyClient | null;
  ambiente: CorreoAmbiente;
  credenciales: CorreoCredenciales;
  config: ConfigCorreoTienda;
  /** En testMode no se llama a AHIVA, no se sube nada y no se toca Shopify. */
  testMode: boolean;
  debeFulfillear: boolean;
  forceAll: boolean;
  /** Catálogo de oficinas. Si no viene, se baja una vez por corrida. */
  catalogo?: LocalidadCorreo[];
  /** Datos extra por pedido (barrio, agencia pedida, peso real), por referencia de pedido. */
  extrasPorPedido?: Record<string, ExtrasPedido>;
  log: {
    info: (paso: string, msg: string, meta?: unknown) => void;
    warn: (paso: string, msg: string, meta?: unknown) => void;
    error: (paso: string, msg: string, meta?: unknown) => void;
    success: (paso: string, msg: string, meta?: unknown) => void;
  };
}

export interface ResultadoCorreo {
  /** Despachos REALES: hay guía de AHIVA. Es lo que el job informa y factura. */
  procesados: number;
  /**
   * Pedidos que se validaron y se habrían despachado, pero no se mandaron por
   * estar en modo prueba. Se cuentan aparte a propósito: mezclarlos con
   * `procesados` hacía que una corrida de prueba informara "N despachados" sin
   * que existiera una sola guía.
   */
  simulados: number;
  fallidos: number;
  enRevision: number;
  bloqueados: number;
  codigos: string[];
  /** Los pedidos efectivamente despachados. Las fuentes lo usan para marcarlos
   *  cargados: contar "los primeros N" es incorrecto, porque los que van a
   *  revisión se intercalan con los que salen. */
  despachados: Array<{ shopifyOrderId: string; codigo: string }>;
}

const PASO = 'correo-uruguayo';

/**
 * Texto de "dónde retira" para la etiqueta y el panel.
 *
 * Sin el guion cuando el catálogo no trae dirección: hay 2 oficinas reales en
 * producción sin ese dato ("Cainsa" en Artigas y "Centro Cercania ( Joaquín
 * Suarez)" en Canelones), y «Retira en Cainsa — » se lee como un dato roto.
 */
const dondeRetira = (o: LocalidadCorreo): string =>
  o.direccion
    ? `Retira en ${o.nombre} — ${o.direccion}`
    : `Retira en ${o.nombre}${o.ciudad || o.departamento ? ` (${o.ciudad || o.departamento})` : ''}`;

/**
 * Cuánto tiempo un despacho ya resuelto sigue bloqueando un re-despacho.
 * Mismo valor que usa el flujo de DAC para lo mismo. Pasado ese plazo se asume
 * que un humano ya reconcilió; el cierre que NO caduca es la guía en el Label.
 */
const RESOLVED_TTL_MS = 72 * 60 * 60 * 1000;

/** Nota informativa en el pedido de Shopify. Nadie la parsea. */
const notaShopify = (codigo: string, oficina: string, cobra: number | null) =>
  `AutoEnvía: despachado por Correo Uruguayo — ${codigo}. Retira en ${oficina}.` +
  (cobra ? ` Cobrar al entregar: $${cobra}.` : '');

/** Clave de idempotencia, misma forma que usa el flujo de DAC. */
async function claveIdempotencia(tenantId: string, shopifyOrderId: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(`${tenantId}${shopifyOrderId}`).digest('hex');
}

export async function procesarPedidosCorreo(
  ordenes: ShopifyOrder[],
  ctx: CtxCorreo,
): Promise<ResultadoCorreo> {
  const salida: ResultadoCorreo = {
    procesados: 0,
    simulados: 0,
    fallidos: 0,
    enRevision: 0,
    bloqueados: 0,
    codigos: [],
    despachados: [],
  };
  if (ordenes.length === 0) return salida;

  // El catálogo se baja UNA vez por corrida, no una vez por pedido: es una
  // llamada de red y el contenido no cambia entre dos pedidos del mismo lote.
  // Se baja del MISMO ambiente al que se va a despachar — el de test tiene 182
  // oficinas y el de producción 196, así que validar contra el equivocado
  // acepta sucursales que no existen.
  let catalogo = ctx.catalogo;
  if (!catalogo) {
    try {
      catalogo = await obtenerLocalidadesCorreo(ctx.ambiente);
      ctx.log.info(PASO, `Catálogo de oficinas: ${catalogo.length} (${ctx.ambiente})`);
    } catch (err) {
      ctx.log.error(PASO, `No se pudo bajar el catálogo de oficinas: ${(err as Error).message}`);
      salida.fallidos += ordenes.length;
      return salida;
    }
  }

  for (const order of ordenes) {
    const shopifyOrderId = String(order.id);

    // ── 0. ¿Este pedido ya se despachó, o se pudo haber despachado? ─────────
    //
    // Son DOS preguntas y las dos tienen que dar "no" para seguir.
    //
    // (a) ¿Ya hay una guía de Correo emitida para este pedido? Si la hay, no se
    //     re-despacha NUNCA, sin importar el tiempo transcurrido ni en qué
    //     estado quedó la etiqueta. Es el cierre que no caduca.
    //
    // (b) ¿Hay un marcador de un intento anterior? Bloquea PENDING (murió a
    //     mitad), ORPHANED, y también RESOLVED reciente — este último es el que
    //     faltaba y es el más caro: el marcador pasa a RESOLVED ANTES de subir
    //     el PDF, así que un fallo de Supabase dejaba la etiqueta en
    //     NEEDS_REVIEW con el marcador ya resuelto, y como el pedido sigue sin
    //     preparar en su fuente, la corrida siguiente lo volvía a despachar:
    //     segunda guía real, segundo contrareembolso al mismo comprador, y el
    //     código de la primera pisado en la base. Es el mismo incidente de doble
    //     envío del 22-04-2026, y DAC lo cierra con este mismo TTL de 72 h
    //     (dac/shipment.ts).
    // 🔴 SIN `.catch(() => null)`, y es deliberado. Este par de lecturas es lo
    // ÚNICO que impide re-despachar un pedido que ya tiene guía. Tragarse el
    // error convertía "no pude averiguarlo" en "no hay nada": un timeout del
    // pool de pgbouncer (P2024, cosa normal en Supabase bajo carga) alcanzaba
    // para que se emitiera una segunda guía con un segundo contrareembolso al
    // mismo comprador, y encima la primera quedaba pisada y huérfana.
    //
    // Si la base no responde, la excepción sube: el pedido cae en el catch de
    // más abajo, queda NEEDS_REVIEW y se reintenta en la corrida siguiente.
    // Es el mismo criterio de `assertNoPriorSubmit` en dac/shipment.ts, que
    // tampoco envuelve la lectura, y la misma asimetría que fija types.ts:
    // una revisión a mano cuesta un minuto; cobrarle dos veces a alguien, no.
    let labelPrevio: { dacGuia: string | null; carrier: string | null } | null;
    try {
      labelPrevio = await db.label.findUnique({
        where: { tenantId_shopifyOrderId: { tenantId: ctx.tenantId, shopifyOrderId } },
        select: { dacGuia: true, carrier: true },
      });
    } catch (err) {
      salida.fallidos++;
      ctx.log.error(
        PASO,
        `${order.name}: no se pudo leer la etiqueta previa (${(err as Error).message}). ` +
          'No se despacha: sin esa lectura no hay forma de saber si el pedido ya tiene guía.',
      );
      continue;
    }

    // El cierre bloquea ante CUALQUIER guía real previa, no sólo las de Correo.
    // Mirar únicamente `carrier === 'CORREO'` dejaba pasar el peor caso: un
    // pedido que YA salió por DAC entraba de nuevo por acá, se emitía una
    // segunda guía con un segundo cobro al comprador, y encima el update de
    // :344 pisaba la guía de DAC — que es la que el comprador está rastreando.
    // `PENDING-` no cuenta: es el placeholder que usan fulfillment y billing
    // para las etiquetas que todavía no tienen número.
    const guiaPrevia = (labelPrevio?.dacGuia ?? '').trim();
    if (guiaPrevia && !guiaPrevia.startsWith('PENDING-')) {
      salida.bloqueados++;
      const transportistaPrevio = transportistaDe(labelPrevio?.carrier, guiaPrevia);
      ctx.log.warn(
        PASO,
        transportistaPrevio === 'CORREO'
          ? `${order.name} YA tiene la guía de Correo ${guiaPrevia}. No se despacha de nuevo. ` +
              'Si falta la etiqueta impresa, se vuelve a pedir con el código (impresionEtiquetas); ' +
              'volver a despachar sería una segunda guía y un segundo cobro al comprador.'
          : `${order.name} ya tiene la guía ${guiaPrevia} de ${nombreTransportista(transportistaPrevio)}. ` +
              'No se despacha por Correo: sería un segundo envío para el mismo pedido y pisaría ' +
              'la guía que el comprador está rastreando. Resolvelo a mano antes de reintentar.',
      );
      continue;
    }

    // Misma regla que la lectura de arriba: si no se puede consultar el
    // marcador, no se despacha. Fallar cerrado es la única opción segura.
    let previo;
    try {
      previo = await db.pendingShipment.findUnique({
        where: { tenantId_shopifyOrderId: { tenantId: ctx.tenantId, shopifyOrderId } },
      });
    } catch (err) {
      salida.fallidos++;
      ctx.log.error(
        PASO,
        `${order.name}: no se pudo leer el marcador de idempotencia (${(err as Error).message}). ` +
          'No se despacha: podría haber un envío en curso sin registrar.',
      );
      continue;
    }

    if (previo) {
      const resueltoHaceMs = Date.now() - previo.submitAttemptedAt.getTime();
      const resueltoReciente = previo.status === 'RESOLVED' && resueltoHaceMs < RESOLVED_TTL_MS;
      if (previo.status !== 'RESOLVED' || resueltoReciente) {
        salida.bloqueados++;
        ctx.log.warn(
          PASO,
          previo.status === 'RESOLVED'
            ? `${order.name} ya se despachó hace ${Math.round(resueltoHaceMs / 60000)} min ` +
                `(guía ${previo.resolvedGuia ?? 'sin registrar'}). NO se reintenta: si falta la etiqueta, ` +
                'pedila con el código en vez de emitir un envío nuevo.'
            : `${order.name} tiene un intento previo sin resolver del ${previo.submitAttemptedAt.toISOString()}. ` +
                'NO se reintenta: Correo no permite consultar envíos por referencia, así que puede haber ' +
                'una guía emitida sin registrar. Verificá en "Mis envíos" del portal antes de destrabarlo.',
        );
        continue;
      }
    }

    // Sólo se pone en true cuando AHIVA rechaza explícitamente: es la única
    // situación en la que se puede afirmar que no se creó ningún envío.
    let rechazadoPorAhiva = false;

    try {
      // ── 1. Armar el envío. Todo lo que se puede rechazar, se rechaza ANTES
      // de gastar una llamada que emite una guía real.
      const adaptado = pedidoDesdeOrden(
        order,
        catalogo,
        ctx.config,
        ctx.extrasPorPedido?.[order.name] ?? {},
      );
      if (!adaptado.ok) {
        await marcarRevision(ctx, order, adaptado.motivos, adaptado.candidatas);
        salida.enRevision++;
        continue;
      }

      const preVuelo = construirEnvio(adaptado.pedido, catalogo);
      if (!preVuelo.ok) {
        await marcarRevision(ctx, order, preVuelo.motivos, []);
        salida.enRevision++;
        continue;
      }
      for (const aviso of preVuelo.avisos) ctx.log.info(PASO, `${order.name}: ${aviso}`);

      // ── 2. Fila en Label ANTES de llamar a AHIVA, igual que reparto propio:
      // si algo falla después, el pedido queda visible en el dashboard en vez de
      // desaparecer.
      const addr = order.shipping_address!;
      const { fullAddress } = mergeAddress(addr.address1, addr.address2);
      const { safeCity, safeDepartment } = buildSafeLabelGeoFields({
        city: addr.city,
        province: addr.province,
        resolvedDepartment: adaptado.oficina.departamento,
      });

      const label = await db.label.upsert({
        where: { tenantId_shopifyOrderId: { tenantId: ctx.tenantId, shopifyOrderId } },
        create: {
          tenantId: ctx.tenantId,
          jobId: ctx.jobId,
          shopifyOrderId,
          shopifyOrderName: order.name,
          customerName: adaptado.pedido.nombre ?? 'Sin nombre',
          customerEmail: order.email || null,
          customerPhone: adaptado.pedido.celular ?? null,
          deliveryAddress: dondeRetira(adaptado.oficina),
          city: safeCity,
          department: safeDepartment,
          totalUyu: Number(order.total_price) || 0,
          paymentType: ctx.config.pagaFlete === 'REMITENTE' ? 'REMITENTE' : 'DESTINATARIO',
          paymentStatus: 'not_required',
          codAmount: adaptado.pedido.codAmount ?? null,
          carrier: 'CORREO',
          status: 'PENDING',
        },
        update: {
          jobId: ctx.jobId,
          carrier: 'CORREO',
          status: 'PENDING',
          errorMessage: null,
          codAmount: adaptado.pedido.codAmount ?? null,
          deliveryAddress: dondeRetira(adaptado.oficina),
          city: safeCity,
          department: safeDepartment,
        },
      });

      await persistLabelItems(label.id, order, ctx.log);

      if (ctx.testMode) {
        ctx.log.info(PASO, `[testMode] ${order.name} no se despacha; iría a ${adaptado.oficina.nombre}`);
        salida.simulados++;
        continue;
      }

      // ── 3. Marcador de idempotencia. VA ANTES de la llamada, no después.
      await db.pendingShipment.upsert({
        where: { tenantId_shopifyOrderId: { tenantId: ctx.tenantId, shopifyOrderId } },
        create: {
          tenantId: ctx.tenantId,
          shopifyOrderId,
          labelId: label.id,
          idempotencyKey: await claveIdempotencia(ctx.tenantId, shopifyOrderId),
          status: 'PENDING',
        },
        update: { labelId: label.id, status: 'PENDING', resolvedAt: null, resolvedGuia: null },
      });

      // ── 4. La llamada que emite la guía real. ────────────────────────────
      //
      // `rechazadoPorAhiva` distingue las dos clases de fallo que NO se pueden
      // confundir: "AHIVA contestó que no" (no creó nada → el marcador se
      // levanta y el pedido se puede corregir y reintentar) de "no sabemos qué
      // pasó" (timeout, red, respuesta rara → el marcador QUEDA, porque el envío
      // puede existir y no hay forma de preguntarle a Correo si existe).
      let respuesta;
      try {
        respuesta = await cargaMasiva({
          ambiente: ctx.ambiente,
          credenciales: ctx.credenciales,
          envios: [preVuelo.envio],
        });
      } catch (err) {
        // SÓLO un rechazo explícito de AHIVA prueba que no se creó nada. Antes
        // esto miraba `!err.retryable`, que también es true para un HTTP 4xx o
        // un corte de red con un `code` que no está en la lista de `esRed` —
        // incluido el corte MIENTRAS AHIVA devuelve la etiqueta, que es
        // justamente el caso en que el envío SÍ existe. Esa confusión levantaba
        // el marcador y la corrida siguiente emitía una segunda guía con un
        // segundo cobro al comprador.
        if (err instanceof CorreoError && err.esRechazoDeNegocio) rechazadoPorAhiva = true;
        throw err;
      }

      const envio = respuesta.envios[0];
      const codigo = envio?.codigostrazabilidad?.[0];
      if (!codigo) {
        // AHIVA contestó SIN error pero sin código. Es el caso más incierto de
        // todos: no se puede afirmar que el envío no se creó. `rechazadoPorAhiva`
        // queda en false a propósito, así el marcador sobrevive y nadie
        // re-despacha a ciegas.
        throw new Error(
          `AHIVA respondió ${respuesta.codigoRespuesta} (${respuesta.descripcionRespuesta}) sin código de trazabilidad. ` +
            'El envío PUEDE haberse creado: verificá en "Mis envíos" del portal antes de reintentar.',
        );
      }

      // ── 5. El envío existe. A partir de acá NADA puede volver a llamar a
      // AHIVA por este pedido: lo primero es guardar el código.
      await db.label.update({
        where: { id: label.id },
        data: { dacGuia: codigo, carrier: 'CORREO' },
      });
      await db.pendingShipment.update({
        where: { tenantId_shopifyOrderId: { tenantId: ctx.tenantId, shopifyOrderId } },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedGuia: codigo },
      });

      // Ledger en sombra (WALLET_SHADOW=1), igual que DAC en
      // process-orders.job.ts:1169. Va ACÁ, con la guía ya persistida, y no
      // antes: el ledger asienta hechos, no intenciones.
      //
      // Un envío de Correo consume crédito igual que uno de DAC (por eso el
      // despacho pasa por el mismo gate de saldo), así que omitirlo dejaba el
      // ledger contando de menos mientras el crédito SÍ se descontaba — o sea,
      // las dos contabilidades divergían y la de sombra no servía para
      // conciliar. `at` = Label.createdAt: el período contable es el del hecho.
      await shadowRecordShipment({
        tenantId: ctx.tenantId,
        dacGuia: codigo,
        labelId: label.id,
        jobId: ctx.jobId,
        at: label.createdAt,
      });

      salida.codigos.push(codigo);

      // ── 6. La etiqueta que devolvió AHIVA, en base64.
      let pdfPath: string | null = null;
      let errorPdf: string | null = null;
      if (envio.etiquetasBase64) {
        const pdf = Buffer.from(envio.etiquetasBase64, 'base64');
        const up = await uploadLabelPdf(ctx.tenantId, label.id, pdf);
        if (up.error) errorPdf = up.error;
        else pdfPath = up.path;
      } else {
        errorPdf = 'AHIVA no devolvió etiqueta en la respuesta';
      }

      if (!pdfPath) {
        // El envío está hecho y facturado, pero sin etiqueta imprimible no se
        // puede despachar la caja. NO se marca COMPLETED ni se fulfillea: eso
        // le diría al comprador que su pedido salió cuando nadie lo puede pegar
        // en el paquete. Es recuperable: `impresionEtiquetas` devuelve el PDF de
        // nuevo a partir del código.
        await db.label.update({
          where: { id: label.id },
          data: {
            status: 'NEEDS_REVIEW',
            errorMessage:
              `Envío creado en Correo (${codigo}) pero la etiqueta no se pudo guardar: ${errorPdf}. ` +
              'Se puede volver a pedir con el código, NO reintentar el despacho.',
          },
        });
        salida.enRevision++;
        ctx.log.error(PASO, `${order.name}: envío ${codigo} creado, etiqueta no guardada — a revisión`);
        continue;
      }

      await db.label.update({
        where: { id: label.id },
        data: { status: 'COMPLETED', pdfPath, pdfUrl: pdfPath },
      });

      ctx.log.success(PASO, `Guía de Correo emitida para ${order.name}`, {
        codigo,
        oficina: adaptado.oficina.nombre,
        motivoOficina: adaptado.motivoOficina,
        cobraEnDestino: adaptado.pedido.codAmount ?? null,
        costos: envio.costos ?? null,
      });

      // ── 7. Shopify: preparado + tag + nota. Sólo si el pedido vive en Shopify.
      if (ctx.shopifyClient && ctx.debeFulfillear) {
        try {
          await fulfillOrderWithTracking(
            ctx.shopifyClient,
            order.id,
            codigo,
            urlSeguimientoComprador(codigo),
            ctx.forceAll,
            { company: 'Correo Uruguayo' },
          );
        } catch (err) {
          if (err instanceof ShopifyAlreadyFulfilledError) {
            ctx.log.info(PASO, `${order.name} ya estaba preparado en Shopify — no lo toco`);
          } else if (err instanceof ShopifyMissingScopesError) {
            ctx.log.error(PASO, `Shopify CONFIG ERROR: ${err.message}`);
          } else {
            ctx.log.warn(PASO, `No se pudo marcar preparado ${order.name}: ${(err as Error).message}`);
          }
        }
      }

      if (ctx.shopifyClient) {
        await markOrderProcessed(ctx.shopifyClient, order.id, codigo).catch((e) =>
          ctx.log.warn(PASO, `No se pudo etiquetar ${order.name} en Shopify: ${(e as Error).message}`),
        );
        await addOrderNote(
          ctx.shopifyClient,
          order.id,
          notaShopify(codigo, adaptado.oficina.nombre, adaptado.pedido.codAmount ?? null),
        ).catch(() => {});
      }

      salida.procesados++;
      salida.despachados.push({ shopifyOrderId, codigo });
    } catch (err) {
      salida.fallidos++;
      const e = err as Error;
      const esNegocio = rechazadoPorAhiva;

      // Sólo un rechazo explícito de AHIVA levanta el marcador. Cualquier otra
      // cosa —timeout, red, respuesta sin código, error nuestro después de la
      // llamada— lo deja puesto, porque el envío puede existir y no hay consulta
      // por referencia con la que averiguarlo.
      if (esNegocio) {
        await db.pendingShipment
          .deleteMany({ where: { tenantId: ctx.tenantId, shopifyOrderId } })
          .catch(() => {});
      }

      ctx.log.error(
        PASO,
        `Falló el despacho de ${order.name}: ${e.message}` +
          (esNegocio ? '' : ' — el marcador queda puesto: verificá en el portal antes de reintentar'),
      );

      await db.label
        .updateMany({
          where: { tenantId: ctx.tenantId, shopifyOrderId },
          data: {
            status: esNegocio ? 'FAILED' : 'NEEDS_REVIEW',
            errorMessage: `Correo Uruguayo: ${e.message}`.slice(0, 500),
          },
        })
        .catch(() => {});
    }
  }

  return salida;
}

/** Deja el pedido visible en el dashboard con el motivo exacto, sin llamar a AHIVA. */
async function marcarRevision(
  ctx: CtxCorreo,
  order: ShopifyOrder,
  motivos: string[],
  candidatas: string[],
): Promise<void> {
  const detalle =
    motivos.join(' · ') +
    (candidatas.length ? ` — agencias posibles: ${candidatas.slice(0, 10).join(', ')}` : '');

  ctx.log.warn(PASO, `${order.name} no se puede despachar por Correo: ${detalle}`);

  const addr = order.shipping_address;
  await db.label
    .upsert({
      where: { tenantId_shopifyOrderId: { tenantId: ctx.tenantId, shopifyOrderId: String(order.id) } },
      create: {
        tenantId: ctx.tenantId,
        jobId: ctx.jobId,
        shopifyOrderId: String(order.id),
        shopifyOrderName: order.name,
        customerName:
          [addr?.first_name, addr?.last_name].filter(Boolean).join(' ').trim() || order.email || 'Sin nombre',
        customerEmail: order.email || null,
        customerPhone: addr?.phone || order.phone || null,
        deliveryAddress: addr?.address1 ?? '',
        city: addr?.city ?? '',
        department: addr?.province ?? '',
        totalUyu: Number(order.total_price) || 0,
        paymentType: 'DESTINATARIO',
        paymentStatus: 'not_required',
        carrier: 'CORREO',
        status: 'NEEDS_REVIEW',
        errorMessage: detalle.slice(0, 500),
      },
      update: {
        jobId: ctx.jobId,
        carrier: 'CORREO',
        status: 'NEEDS_REVIEW',
        errorMessage: detalle.slice(0, 500),
      },
    })
    .catch(() => {});
}
