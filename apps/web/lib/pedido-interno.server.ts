import { db } from './db';

/**
 * ¿Hay que exigir el mail del destinatario en la carga propia?
 *
 * Sí cuando la tienda despacha por Correo Uruguayo (`Tenant.correoEnabled`):
 * AHIVA lo pide para avisar la llegada y `correo/validate.ts` (worker) rechaza
 * el pedido sin él, en cada corrida, sin que salga nunca. Para DAC es opcional.
 *
 * Se decide ACÁ, con la fila del tenant, y se le pasa a `normalizarPedido`
 * (que es puro y no toca la base). El formulario recibe el mismo flag por el
 * `meta` de `GET /api/v1/pedidos`, así que las dos puntas corren la misma
 * función con el mismo dato y no pueden decir cosas distintas.
 */
export async function exigirEmailParaTenant(tenantId: string): Promise<boolean> {
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { correoEnabled: true } });
  return !!t?.correoEnabled;
}
