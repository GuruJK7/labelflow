import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { normalizarPedido, type PedidoCrudo } from '@/lib/pedido-interno';
import type { Prisma } from '@prisma/client';

/**
 * Editar o borrar un pedido de la carga propia.
 *
 * 🔴 Las dos cosas sólo valen mientras el pedido siga PENDIENTE. Una vez que
 * salió la guía, el pedido queda congelado: una guía de DAC ya está emitida y
 * facturada, y no se deshace desde acá. Dejar editar después haría que la fila
 * dejara de describir lo que de verdad se despachó.
 */

interface Ctx {
  params: { id: string };
}

export async function PUT(req: Request, { params }: Ctx) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Datos inválidos', 400);
  }

  const actual = await db.pedidoInterno.findFirst({
    where: { id: params.id, tenantId: auth.tenantId },
    select: { estado: true },
  });
  if (!actual) return apiError('Ese pedido no existe', 404);
  if (actual.estado !== 'PENDIENTE') {
    return apiError(
      actual.estado === 'DESPACHADO'
        ? 'Ese pedido ya tiene guía emitida: no se puede editar.'
        : 'Ese pedido está cancelado.',
      409,
    );
  }

  const r = normalizarPedido(body as PedidoCrudo);
  if (!r.ok) return apiError(r.errores.join('. '), 400);
  const p = r.pedido;

  // updateMany (no update) para que el filtro por tenantId y estado viaje EN la
  // escritura: entre el chequeo de arriba y esta línea el worker pudo haberlo
  // despachado, y no queremos pisarle los datos a una guía ya emitida.
  const res = await db.pedidoInterno.updateMany({
    where: { id: params.id, tenantId: auth.tenantId, estado: 'PENDIENTE' },
    data: {
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
    },
  });

  if (res.count === 0) {
    return apiError('El pedido se despachó mientras lo editabas: quedó como salió.', 409);
  }

  return apiSuccess({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Mismo motivo que arriba: el estado va en el WHERE del borrado, no en un
  // chequeo previo. Un pedido despachado no se borra — su guía existe.
  const res = await db.pedidoInterno.deleteMany({
    where: { id: params.id, tenantId: auth.tenantId, estado: 'PENDIENTE' },
  });

  if (res.count === 0) {
    const existe = await db.pedidoInterno.findFirst({
      where: { id: params.id, tenantId: auth.tenantId },
      select: { estado: true },
    });
    if (!existe) return apiError('Ese pedido no existe', 404);
    return apiError('Ese pedido ya tiene guía emitida: no se puede borrar.', 409);
  }

  return apiSuccess({ ok: true });
}
