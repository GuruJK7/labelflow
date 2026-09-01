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
 * Estados incluidos: CREATED y COMPLETED. Son los que tienen envío real emitido
 * (CREATED = guía de DAC ya emitida; COMPLETED = además con PDF subido). Las
 * PENDING todavía no tienen guía, y FAILED/SKIPPED/NEEDS_REVIEW no se despachan.
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import {
  buildWmsExportPayload,
  parseZona,
  uyDayRange,
  uyToday,
  type WmsExportLabelRow,
} from '@/lib/wms-export';

export const dynamic = 'force-dynamic';

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

  const dateParam = req.nextUrl.searchParams.get('date') ?? uyToday();
  const range = uyDayRange(dateParam);
  if (!range) return apiError('Parámetro date inválido — se espera YYYY-MM-DD', 400);

  const zona = parseZona(req.nextUrl.searchParams.get('zona'));
  if (!zona) {
    return apiError('Parámetro zona inválido — se espera maldonado, resto o todas', 400);
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true },
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
    orderBy: [
      { packSeq: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
    ],
    select: {
      id: true,
      shopifyOrderName: true,
      dacGuia: true,
      customerName: true,
      deliveryAddress: true,
      city: true,
      department: true,
      createdAt: true,
      packSeq: true,
      printedAt: true,
      items: {
        orderBy: { createdAt: 'asc' },
        select: { sku: true, title: true, quantity: true },
      },
    },
  });

  const payload = buildWmsExportPayload(labels as WmsExportLabelRow[], {
    fecha: dateParam,
    cliente: tenant.name,
    zona,
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
  });
}
