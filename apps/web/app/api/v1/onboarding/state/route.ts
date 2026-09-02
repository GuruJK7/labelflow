import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { loadOnboardingState } from '@/lib/onboarding-state.server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/onboarding/state
 *
 * Estado del wizard derivado de la base (D33). El wizard lo pide después de
 * cada guardado exitoso para saltar al paso que corresponde y para pintar el
 * progreso; el server component de /onboarding usa el mismo loader para el
 * primer render. Nunca devuelve tokens ni contraseñas.
 */
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const state = await loadOnboardingState(auth.tenantId);
  if (!state) return apiError('Tenant no encontrado', 404);

  return apiSuccess(state);
}
