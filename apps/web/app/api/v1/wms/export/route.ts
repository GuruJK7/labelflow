/**
 * GET /api/v1/wms/export?date=YYYY-MM-DD[&zona=maldonado|resto|todas]
 *
 * Devuelve la tanda del día del tenant en el formato que el WMS (DEPO) importa
 * con su RPC `importar_tanda`. El armado del payload vive en lib/wms-export.ts
 * (puro y testeado); acá sólo hay auth, validación de query y la consulta.
 *
 * ── Auth: DOS caminos, en este orden ─────────────────────────────────────────
 *  1. `Authorization: Bearer <Tenant.apiKey>` — server-to-server. Es como entra
 *     DEPO (`traerTandaAutoenvia` en wms-mvp lo manda así, con la key en la env
 *     var AUTOENVIA_EXPORT_KEY). Mismo patrón que /api/v1/mcp: lookup directo
 *     por `apiKey` (columna @unique) y 401 si no matchea.
 *  2. Sesión NextAuth (`getAuthenticatedTenant`) — el operador abriendo la URL
 *     en el navegador para copiar el JSON a mano.
 *
 * ⚠️ La ruta está en `publicPaths` del middleware (como /api/v1/mcp): sin eso
 * el middleware rebota el Bearer con 401 antes de llegar acá. La autorización
 * REAL es la de este handler, que nunca devuelve datos sin resolver un tenant.
 *
 * Sobre la comparación de la key: es un lookup por índice único en Postgres, no
 * un compare en Node, así que no hay un `===` sobre el secreto del que se pueda
 * sacar timing. Es exactamente lo que ya hace /api/v1/mcp en producción.
 *
 * `date` es el día LOCAL de Uruguay, no UTC. Ver uyDayRange() para el porqué.
 *
 * `zona` parte la tanda: `maldonado` (lo que reparte LabelFlow), `resto` (lo que
 * se va por DAC) o `todas` (default). El discriminador es el mismo que agrupa
 * las etiquetas en el portal del cliente — ver lib/departamentos.ts.
 *
 * ── Ítems: read-through backfill ─────────────────────────────────────────────
 * Las Labels sin filas en LabelItem (todas las anteriores al 2026-09-01 19:19)
 * se completan contra la Admin API de Shopify EN ESTE MISMO request y quedan
 * persistidas — ver lib/wms-items-backfill.ts. El primer export después del
 * deploy paga ese costo una vez; los siguientes salen del snapshot. Si Shopify
 * no responde, esas etiquetas caen a `sin_items` como antes: nunca un 500.
 *
 * ── pdf_url: el papel, no sólo los datos ────────────────────────────────────
 * Cada pedido (en `pedidos` y en `sin_items`) trae `pdf_url`: la URL FIRMADA
 * del PDF de la etiqueta, para que DEPO imprima la tanda sin entrar al portal.
 * Se firma con el mismo helper que el portal (lib/label-pdf.ts) y vive UNA
 * hora; `meta.expira_en` dice hasta cuándo. Es null cuando la etiqueta no tiene
 * `pdfPath` o cuando la firma falló — ver lib/wms-export-pdf.ts. Clave ADITIVA:
 * los consumidores que ya existen la ignoran y siguen andando igual.
 *
 * Estados incluidos: CREATED y COMPLETED. Son los que tienen envío real emitido
 * (CREATED = guía de DAC ya emitida; COMPLETED = además con PDF subido). Las
 * PENDING todavía no tienen guía, y FAILED/SKIPPED/NEEDS_REVIEW no se despachan.
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import {
  buildWmsExportPayload,
  filtrarZona,
  parseZona,
  uyDayRange,
  uyToday,
  type WmsExportLabelRow,
} from '@/lib/wms-export';
import { applyBackfilledItems, backfillMissingItems } from '@/lib/wms-items-backfill';
import { signWmsExportPdfUrls } from '@/lib/wms-export-pdf';

export const dynamic = 'force-dynamic';

/**
 * El PRIMER export después del deploy paga el read-through backfill de todas
 * las etiquetas históricas del día (1 request a Shopify por cada 250 + los
 * writes). Con el default de Vercel eso puede cortarse por timeout justo en el
 * request que más importa. 60s es el mismo techo que ya usan
 * /api/v1/tenants/[tenantId] y /api/public/label-pdf/bulk. Los exports
 * siguientes vuelven a ser una sola consulta.
 */
export const maxDuration = 60;

/** Lo que selecciona la consulta: el shape del export + la clave de Shopify. */
type ExportRow = WmsExportLabelRow & { shopifyOrderId: string };

/**
 * Resuelve el tenant: primero la API key del header, después la sesión.
 * Devuelve null cuando ninguno de los dos identifica un tenant.
 */
async function resolveTenantId(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const apiKey = match?.[1]?.trim();

  if (apiKey) {
    const tenant = await db.tenant.findUnique({
      where: { apiKey },
      select: { id: true },
    });
    // Con header presente NO caemos a la sesión: una key inválida es un 401,
    // no una invitación a probar con las cookies que el cliente traiga.
    return tenant?.id ?? null;
  }

  const auth = await getAuthenticatedTenant();
  return auth?.tenantId ?? null;
}

export async function GET(req: NextRequest) {
  const tenantId = await resolveTenantId(req);
  if (!tenantId) return apiError('No autorizado', 401);

  // `||` y no `??`: `?date=` (presente pero vacío) devuelve '' , no null, y con
  // `??` eso llegaba a uyDayRange() como cadena vacía → 400. Un date vacío es
  // "no me dijiste qué día", igual que no mandar el parámetro: cae a hoy.
  const dateParam = req.nextUrl.searchParams.get('date') || uyToday();
  const range = uyDayRange(dateParam);
  if (!range) return apiError('Parámetro date inválido — se espera YYYY-MM-DD', 400);

  const zona = parseZona(req.nextUrl.searchParams.get('zona'));
  if (!zona) {
    return apiError('Parámetro zona inválido — se espera maldonado, resto o todas', 400);
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    // shopifyStoreUrl/shopifyToken son para el read-through backfill de ítems
    // (lib/wms-items-backfill.ts). El token viaja cifrado y se descifra ahí.
    select: { name: true, shopifyStoreUrl: true, shopifyToken: true },
  });
  if (!tenant) return apiError('Tenant no encontrado', 404);

  const labels = await db.label.findMany({
    where: {
      tenantId,
      status: { in: ['CREATED', 'COMPLETED'] },
      createdAt: { gte: range.gte, lt: range.lt },
    },
    // Orden de la PILA FÍSICA impresa. Las que nunca se imprimieron en bulk
    // (packSeq null) caen al final, en el orden en que se generaron.
    // El `id` es el desempate final: dos etiquetas de la misma corrida pueden
    // compartir createdAt al milisegundo y Postgres no garantiza un orden
    // estable para el resto — sin esto, dos exports del mismo día podrían
    // devolver esas filas al revés y DEPO vería una tanda distinta.
    orderBy: [
      { packSeq: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
    select: {
      id: true,
      // Necesario para el backfill: es la clave contra la Admin API de Shopify.
      shopifyOrderId: true,
      shopifyOrderName: true,
      dacGuia: true,
      customerName: true,
      deliveryAddress: true,
      city: true,
      department: true,
      createdAt: true,
      packSeq: true,
      printedAt: true,
      // Ruta del PDF en el bucket: la firma para `pdf_url` sale de acá.
      pdfPath: true,
      items: {
        // Mismo desempate: los LabelItem se escriben con un createMany dentro
        // de una transacción, así que TODOS comparten el createdAt al ms.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { sku: true, title: true, quantity: true },
      },
    },
  });

  // ── Read-through backfill ───────────────────────────────────────────────
  // Las Labels anteriores al deploy del snapshot de ítems (2026-09-01 19:19) no
  // tienen filas en LabelItem y salían TODAS por `sin_items`, con lo que DEPO
  // importaba cero. Antes de armar el payload se completan desde Shopify y se
  // persisten, así el export se auto-cura y el costo se paga una sola vez.
  //
  // Se backfillea sólo lo que entra en la zona pedida: `?zona=maldonado` no
  // tiene por qué pagar los requests de la pila que se va por DAC.
  //
  // Nunca tira: si Shopify falla, `recuperados` viene vacío y esas etiquetas
  // caen a `sin_items` exactamente como antes de este cambio.
  const rows = labels as ExportRow[];
  // Se calcula UNA vez y se reusa: tanto el backfill de ítems como la firma de
  // PDFs trabajan sólo sobre lo que realmente se va a exportar.
  const enZona = filtrarZona(rows, zona);

  const backfill = await backfillMissingItems(enZona, {
    shopifyStoreUrl: tenant.shopifyStoreUrl,
    shopifyToken: tenant.shopifyToken,
  });

  // ── URLs firmadas de los PDFs ───────────────────────────────────────────
  // Para que DEPO imprima la tanda sin pasar por el portal. Va DESPUÉS del
  // backfill a propósito: si Shopify se comió el presupuesto de tiempo, la
  // firma se recorta sola (SIGN_BUDGET_MS) y esas etiquetas salen con
  // `pdf_url: null` en vez de tumbar el export con un timeout.
  const pdfs = await signWmsExportPdfUrls(enZona);

  const payload = buildWmsExportPayload(applyBackfilledItems(rows, backfill.items), {
    fecha: dateParam,
    cliente: tenant.name,
    zona,
    pdfUrls: pdfs.urls,
  });

  return apiSuccess(payload, {
    // `total` es lo que trajo la consulta del día ANTES del filtro de zona;
    // con ?zona= puede ser mayor que pedidos + sin_items, y así se ve cuánto
    // quedó afuera sin tener que pedir la otra zona.
    total: labels.length,
    zona,
    con_items: payload.pedidos.length,
    sin_items: payload.sin_items.length,
    reparto_propio: payload.pedidos.filter((p) => p.reparto_propio).length,
    // Observabilidad del backfill: `recuperadas` > 0 en el primer export
    // después del deploy y ~0 de ahí en más. Si `recuperadas` se mantiene alto
    // export tras export, la persistencia no está entrando (mirar persistidas).
    backfill: {
      intentadas: backfill.intentadas,
      recuperadas: backfill.recuperadas,
      persistidas: backfill.persistidas,
      ...(backfill.skipped ? { skipped: backfill.skipped } : {}),
    },
    // Hasta cuándo sirven los `pdf_url` de ESTA respuesta. Null = no se firmó
    // ninguna (ninguna etiqueta tenía PDF, o el storage no está configurado).
    // Un export guardado y reabierto después de esta hora tiene los links
    // muertos: hay que volver a pedirlo, no hay forma de renovarlos sueltos.
    expira_en: pdfs.expiraEn,
    // Observabilidad de la firma: `con_pdf` son las etiquetas de la zona que
    // tienen PDF y `firmadas` las que quedaron con URL usable. Si firmadas <
    // con_pdf de forma sostenida, mirar el bucket o la service role key.
    pdf: { con_pdf: pdfs.conPdf, firmadas: pdfs.firmadas },
  });
}
