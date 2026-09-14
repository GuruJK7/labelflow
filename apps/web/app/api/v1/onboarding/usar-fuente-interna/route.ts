import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

/**
 * POST /api/v1/onboarding/usar-fuente-interna
 *
 * Elegir la carga propia como fuente de pedidos. No recibe nada y no hay nada
 * que probar: a diferencia de `test-dashboard`, acá no existe un sistema externo
 * al que pegarle. Es exactamente el punto — quien no vende por Shopify y no
 * tiene otro panel ahora tiene una salida.
 *
 * Idempotente: llamarlo dos veces no cambia nada.
 */
export async function POST() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  await db.tenant.update({
    where: { id: auth.tenantId },
    data: { internalSourceEnabled: true },
  });

  return apiSuccess({ ok: true });
}

/**
 * DELETE — apagarla. Los pedidos ya cargados NO se borran: si vuelve a
 * prenderla, siguen ahí. Apagar una fuente es una decisión de ruteo, no una
 * orden de tirar datos.
 */
export async function DELETE() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  await db.tenant.update({
    where: { id: auth.tenantId },
    data: { internalSourceEnabled: false },
  });

  return apiSuccess({ ok: true });
}
