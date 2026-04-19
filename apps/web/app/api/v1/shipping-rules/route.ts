/**
 * GET  /api/v1/shipping-rules — list all rules for the authenticated tenant,
 *                              ordered by priority ASC then createdAt ASC.
 * POST /api/v1/shipping-rules — create a new rule. Body validated by
 *                              `createRuleSchema` (Zod) in lib/shipping-rules.ts.
 *
 * Both handlers scope strictly to `auth.tenantId`; never accept tenantId from
 * the request body.
 */

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { createRuleSchema } from '@/lib/shipping-rules';

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const rules = await db.shippingRule.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      name: true,
      ruleType: true,
      config: true,
      priority: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return apiSuccess(rules);
}

export async function POST(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('JSON invalido', 400);
  }

  const parsed = createRuleSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return apiError(first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Datos invalidos', 400);
  }

  // Soft cap: prevent a single tenant from creating hundreds of rules.
  const existing = await db.shippingRule.count({ where: { tenantId: auth.tenantId } });
  if (existing >= 50) {
    return apiError('Maximo 50 reglas por tienda', 409);
  }

  const created = await db.shippingRule.create({
    data: {
      tenantId: auth.tenantId,
      name: parsed.data.name,
      ruleType: parsed.data.ruleType,
      // Zod returned the type-validated config; cast to Prisma's Json type.
      config: parsed.data.config as object,
      priority: parsed.data.priority,
      isActive: parsed.data.isActive,
    },
    select: {
      id: true,
      name: true,
      ruleType: true,
      config: true,
      priority: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return apiSuccess(created);
}
