/**
 * PATCH /api/v1/tenants/[tenantId] — rename a store the authenticated user
 * owns. Used by the tenant switcher's inline edit so a user with several
 * stores (all created with the default "Nueva tienda" label) can name them
 * meaningfully ("Karbon Uruguay", "Aura", ...) and tell them apart.
 *
 * Ownership lives in the WHERE clause (id + userId) via updateMany, so a
 * tenant owned by another user is indistinguishable from a non-existent one
 * — both return 403, never leaking which tenantIds belong to other accounts.
 * (Same no-leak posture as /api/v1/tenants/switch.)
 *
 * Body: { name: string }  — 1..80 chars after trim (matches the cap POST uses).
 *
 * Privacy: touches only the display `name`. No secrets are read or returned.
 */

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError, apiSuccess } from '@/lib/api-utils';

const MAX_NAME_LEN = 80;

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  const { tenantId } = await context.params;

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return apiError('Body inválido', 400);
  }

  const name = (body.name ?? '').trim();
  if (name.length === 0) {
    return apiError('El nombre no puede estar vacío', 422);
  }
  if (name.length > MAX_NAME_LEN) {
    return apiError(`El nombre no puede superar ${MAX_NAME_LEN} caracteres`, 422);
  }

  // Ownership is enforced in the filter: only a tenant whose id AND userId
  // both match is touched. count === 0 means "not yours or doesn't exist" —
  // we return the same 403 for both so existence never leaks across accounts.
  const result = await db.tenant.updateMany({
    where: { id: tenantId, userId: auth.userId },
    data: { name },
  });
  if (result.count === 0) {
    return apiError('Tienda no encontrada o no tenés permiso', 403);
  }

  return apiSuccess({ tenant: { id: tenantId, name } });
}
