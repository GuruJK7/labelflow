import type { Prisma } from '@prisma/client';
import { db } from './db';
import { getAuthenticatedUser } from './api-utils';
import { isAdminEmail } from './admin';
import { writeAuditLog } from './audit-log';

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

/**
 * Registra que un OPERADOR miró datos de un cliente que no es suyo.
 *
 * 🔴 POR QUÉ EXISTE. Shopify pregunta, en la solicitud de acceso a datos
 * protegidos, «¿Registrás el acceso a los datos personales?». Hasta el
 * 2026-09-03 la respuesta honesta era NO: `AuditLog` existía y su docblock
 * mencionaba `admin.tenant.impersonate` como ejemplo, pero nadie lo escribía
 * nunca — lo único registrado eran logins y cambios de contraseña. O sea,
 * Adrian podía abrir Control y leer nombres, teléfonos y direcciones de los
 * clientes de cualquier comerciante sin dejar rastro.
 *
 * QUÉ SE REGISTRA Y QUÉ NO. Sólo el acceso de un admin a un tenant AJENO. El
 * comerciante mirando sus propios envíos no es un acceso de operador y
 * registrarlo llenaría la tabla de ruido hasta volverla inútil — un log que
 * nadie puede leer no protege a nadie.
 *
 * NUNCA TIRA. Igual que `writeAuditLog`: si la auditoría falla, la operación
 * del operador sigue. Es defensa en profundidad, no un candado.
 */
export async function auditControlAccess(
  actor: ControlActor,
  tenantId: string,
  action: string,
): Promise<void> {
  if (!actor.isAdmin) return;
  try {
    const propio = await db.tenant.findFirst({
      where: { id: tenantId, userId: actor.userId },
      select: { id: true },
    });
    if (propio) return;
    void writeAuditLog({
      action,
      userId: actor.userId,
      tenantId,
      entityType: 'Tenant',
      entityId: tenantId,
    });
  } catch {
    // Ver el docblock: la auditoría no puede frenar la operación.
  }
}
