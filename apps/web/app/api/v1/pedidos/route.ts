import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { normalizarPedido, type PedidoCrudo, type PedidoNormalizado } from '@/lib/pedido-interno';
import type { Prisma } from '@prisma/client';

/**
 * Los pedidos de la carga propia — listar y crear.
 *
 * GET  /api/v1/pedidos?page&limit&estado
 * POST /api/v1/pedidos            (uno) o { pedidos: [...] } (importación)
 *
 * Toda consulta va acotada por `tenantId`: una tienda no puede ver ni tocar los
 * pedidos de otra ni pasándole un id ajeno.
 */

const LIMITE_MAX = 100;
/** Tope por importación. Con 500 filas el Excel ya es un sistema, no una carga. */
const MAX_POR_LOTE = 500;

const ESTADOS = ['PENDIENTE', 'DESPACHADO', 'CANCELADO'] as const;
type Estado = (typeof ESTADOS)[number];

export async function GET(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(LIMITE_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const estadoRaw = url.searchParams.get('estado');
  const estado = ESTADOS.includes(estadoRaw as Estado) ? (estadoRaw as Estado) : undefined;

  const where = { tenantId: auth.tenantId, ...(estado ? { estado } : {}) };

  const [pedidos, total, pendientes] = await Promise.all([
    db.pedidoInterno.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.pedidoInterno.count({ where }),
    // Para el botón "Despachar ahora": sin pendientes no tiene sentido ofrecerlo.
    db.pedidoInterno.count({ where: { tenantId: auth.tenantId, estado: 'PENDIENTE' } }),
  ]);

  return apiSuccess(pedidos, { total, page, limit, hasNext: page * limit < total, pendientes });
}

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Datos inválidos', 400);
  }

  // Un pedido suelto (alta manual) o muchos (importación de Excel). El mismo
  // validador para los dos caminos, a propósito: si el Excel validara por su
  // cuenta terminaría aceptando cosas que el formulario rechaza.
  const lote = (body as { pedidos?: unknown })?.pedidos;
  const crudos: PedidoCrudo[] = Array.isArray(lote) ? (lote as PedidoCrudo[]) : [body as PedidoCrudo];

  if (crudos.length === 0) return apiError('No mandaste ningún pedido', 400);
  if (crudos.length > MAX_POR_LOTE) {
    return apiError(`Son demasiados de una vez (máximo ${MAX_POR_LOTE}). Partí el archivo.`, 413);
  }

  const validos: PedidoNormalizado[] = [];
  const rechazados: Array<{ fila: number; errores: string[] }> = [];

  crudos.forEach((crudo, i) => {
    const r = normalizarPedido(crudo);
    if (r.ok) validos.push(r.pedido);
    // `fila` es 1-based para que coincida con lo que el comerciante ve en Excel.
    else rechazados.push({ fila: i + 1, errores: r.errores });
  });

  // Un alta manual con errores es un 400: el formulario los muestra y listo.
  // Una importación NO: entran las filas buenas y se reportan las malas, que es
  // lo que evita que una celda mal tipeada frene una planilla entera.
  if (validos.length === 0) {
    return apiError(
      crudos.length === 1 ? rechazados[0].errores.join('. ') : 'Ninguna fila del archivo se pudo importar',
      400,
    );
  }

  const creados = await db.pedidoInterno.createMany({
    data: validos.map((p) => ({
      tenantId: auth.tenantId,
      nombre: p.nombre,
      telefono: p.telefono,
      documento: p.documento,
      departamento: p.departamento,
      localidad: p.localidad,
      direccion: p.direccion,
      agencia: p.agencia,
      referencia: p.referencia,
      items: p.items as unknown as Prisma.InputJsonValue,
      totalUyu: p.totalUyu,
      contraEntrega: p.contraEntrega,
      ...(p.fechaVenta ? { fechaVenta: p.fechaVenta } : {}),
      observaciones: p.observaciones,
    })),
  });

  return apiSuccess({ creados: creados.count, rechazados }, { total: crudos.length });
}
