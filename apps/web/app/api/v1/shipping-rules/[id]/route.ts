/**
 * PUT    /api/v1/shipping-rules/[id] — update name/type/config/priority/isActive.
 * DELETE /api/v1/shipping-rules/[id] — hard-delete the rule.
 *
 * Both scope strictly to `auth.tenantId`. A rule owned by another tenant is
 * treated as 404, never 403, to avoid leaking existence across tenants.
 *
 * Update flow for config:
 *  - If `ruleType` changes, `config` is required and is validated against the
 *    new type's schema (enforced inside `updateRuleSchema`).
 *  - If only `config` changes (no ruleType), we re-validate against the
 *    rule's CURRENT ruleType (looked up from the DB) — `updateRuleSchema`
 *    cannot do this alone because it has no DB access.
 */

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { updateRuleSchema, validateRuleConfig, type ShippingRuleType } from '@/lib/shipping-rules';

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('JSON invalido', 400);
  }

  const parsed = updateRuleSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return apiError(first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Datos invalidos', 400);
  }

  const existing = await db.shippingRule.findFirst({
    where: { id, tenantId: auth.tenantId },
    select: { id: true, ruleType: true },
  });
  if (!existing) return apiError('Regla no encontrada', 404);

  const input = parsed.data;

  // Re-validate config against the *current* ruleType when only config changed.
  if (input.config !== undefined && input.ruleType === undefined) {
    const check = validateRuleConfig(existing.ruleType as ShippingRuleType, input.config);
    if (!check.ok) {
      return apiError(`config: ${check.errors[0] ?? 'invalido'}`, 400);
    }
  }

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.ruleType !== undefined) data.ruleType = input.ruleType;
  if (input.config !== undefined) data.config = input.config as object;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  if (Object.keys(data).length === 0) {
    return apiError('Nada para actualizar', 400);
  }

  const updated = await db.shippingRule.update({
    where: { id },
    data,
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

  return apiSuccess(updated);
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { id } = await context.params;

  // deleteMany with tenantId filter prevents cross-tenant deletes and avoids
  // the existence-vs-permission distinction in the error response.
  const result = await db.shippingRule.deleteMany({
    where: { id, tenantId: auth.tenantId },
  });
  if (result.count === 0) return apiError('Regla no encontrada', 404);

  return apiSuccess({ deleted: true });
}
