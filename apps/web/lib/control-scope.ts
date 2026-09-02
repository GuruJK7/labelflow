import type { Prisma } from '@prisma/client';
import { db } from './db';
import { getAuthenticatedUser } from './api-utils';
import { isAdminEmail } from './admin';

/**
 * Alcance del Centro de Control (D32, revisión 2026-09-02).
 *
 * Adrian pidió que cuando un cliente termina el onboarding su tienda le
 * aparezca en Control desde SU cuenta admin. Hasta acá cada ruta de
 * `/api/v1/control/*` filtraba por `userId` del logueado, así que el admin
 * sólo veía sus propias tiendas.
 *
 * Este módulo es el ÚNICO lugar que decide qué tenants puede ver y operar
 * quien llama a Control:
 *   - usuario normal → sus tenants (exactamente lo que había; nada cambia).
 *   - admin (`ADMIN_EMAILS`, resuelto contra la fila del User, no contra el
 *     JWT, igual que `getAdminSession`) → sus tenants **más** todos los
 *     tenants activos de todos los usuarios. Un tenant ajeno inactivo (no
 *     terminó el onboarding, o está pausado) no entra: la lista y las
 *     acciones usan el mismo filtro, así que lo que no se ve tampoco se
 *     puede ejecutar.
 *
 * Las rutas arman el `where` con `controlTenantWhere(actor)` y lo combinan
 * con el `id` que manda el cliente (`{ id, ...where }`): un no-admin que
 * manda el id de un tenant ajeno sigue recibiendo el mismo 403 de siempre.
 */
export interface ControlActor {
  userId: string;
  isAdmin: boolean;
}

export async function getControlActor(): Promise<ControlActor | null> {
  const auth = await getAuthenticatedUser();
  if (!auth) return null;
  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { email: true },
  });
  return { userId: auth.userId, isAdmin: isAdminEmail(user?.email) };
}

/**
 * Filtro Prisma de los tenants alcanzables desde Control para este actor.
 * Se combina con otras claves del `where` (Prisma las une con AND).
 */
export function controlTenantWhere(actor: ControlActor): Prisma.TenantWhereInput {
  if (!actor.isAdmin) return { userId: actor.userId };
  return { OR: [{ userId: actor.userId }, { isActive: true }] };
}
