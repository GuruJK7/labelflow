/**
 * POST /api/v1/shipping-rules/reorder — accept an ordered array of rule ids
 * and renumber `priority` 0,1,2,... in that order. Rules not listed are left
 * alone (their priority stays). Unknown ids or ids owned by another tenant
 * are rejected with 400 before any write happens.
 *
 * Uses a single transaction so a partial reorder cannot happen.
 */

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { reorderSchema } from '@/lib/shipping-rules';

export async function POST(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('JSON invalido', 400);
  }

  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return apiError(first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Datos invalidos', 400);
  }

  const ids = parsed.data.order;

  // Reject duplicates in the payload itself.
  if (new Set(ids).size !== ids.length) {
    return apiError('order contiene ids duplicados', 400);
  }

  // Verify all ids belong to this tenant BEFORE writing.
  const owned = await db.shippingRule.findMany({
    where: { tenantId: auth.tenantId, id: { in: ids } },
    select: { id: true },
  });
  if (owned.length !== ids.length) {
    return apiError('Uno o mas ids no pertenecen a esta tienda', 400);
  }

  await db.$transaction(
    ids.map((id, idx) =>
      db.shippingRule.update({
        where: { id },
        data: { priority: idx },
      }),
    ),
  );

  return apiSuccess({ reordered: ids.length });
}
