/**
 * GET /api/v1/wms/export?date=YYYY-MM-DD
 *
 * Devuelve la tanda del día del tenant en el formato que el WMS (DEPO) importa
 * con su RPC `importar_tanda`. El armado del payload vive en lib/wms-export.ts
 * (puro y testeado); acá sólo hay auth, validación de query y la consulta.
 *
 * Auth: sesión NextAuth, igual que /api/v1/orders (getAuthenticatedTenant).
 * NO hay API key server-to-server todavía: hoy esto se usa desde el navegador
 * del operador (copiar/pegar el JSON en el diálogo de importar de DEPO). El día
 * que DEPO tire del endpoint solo, hace falta agregar una key con comparación
 * timing-safe — no reutilizar la sesión.
 *
 * `date` es el día LOCAL de Uruguay, no UTC. Ver uyDayRange() para el porqué.
 *
 * Estados incluidos: CREATED y COMPLETED. Son los que tienen envío real emitido
 * (CREATED = guía de DAC ya emitida; COMPLETED = además con PDF subido). Las
 * PENDING todavía no tienen guía, y FAILED/SKIPPED/NEEDS_REVIEW no se despachan.
 */
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { buildWmsExportPayload, uyDayRange, uyToday, type WmsExportLabelRow } from '@/lib/wms-export';

export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const dateParam = req.nextUrl.searchParams.get('date') ?? uyToday();
  const range = uyDayRange(dateParam);
  if (!range) return apiError('Parámetro date inválido — se espera YYYY-MM-DD', 400);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { name: true },
  });
  if (!tenant) return apiError('Tenant no encontrado', 404);

  const labels = await db.label.findMany({
    where: {
      tenantId: auth.tenantId,
      status: { in: ['CREATED', 'COMPLETED'] },
      createdAt: { gte: range.gte, lt: range.lt },
    },
    // Ascendente: el primero generado es el primero de la pila impresa.
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      shopifyOrderName: true,
      dacGuia: true,
      customerName: true,
      deliveryAddress: true,
      city: true,
      createdAt: true,
      items: {
        orderBy: { createdAt: 'asc' },
        select: { sku: true, title: true, quantity: true },
      },
    },
  });

  const payload = buildWmsExportPayload(labels as WmsExportLabelRow[], {
    fecha: dateParam,
    cliente: tenant.name,
  });

  return apiSuccess(payload, {
    total: labels.length,
    con_items: payload.pedidos.length,
    sin_items: payload.sin_items.length,
  });
}
