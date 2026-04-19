/**
 * shipping-rules.ts (web) — shared types + Zod validators for the ShippingRule
 * API layer and the dashboard UI. Runtime behavior stays in the worker
 * (apps/worker/src/rules/shipping.ts); this file deliberately duplicates the
 * small amount of validation needed to keep the two apps decoupled.
 *
 * Invariant: the union of ShippingRuleType + per-type config shape MUST match
 * the worker's `RULE_CONFIG_SCHEMAS`. If you add/change a rule type, update
 * both files (and the Prisma enum).
 */

import { z } from 'zod';

export const SHIPPING_RULE_TYPES = [
  'THRESHOLD_TOTAL',
  'CONSECUTIVE_ORDERS',
  'NTH_SHIPMENT_FREE',
  'CUSTOMER_TAG',
  'ITEM_COUNT',
] as const;
export type ShippingRuleType = (typeof SHIPPING_RULE_TYPES)[number];

/* ─── Per-type config schemas (Zod) ───────────────────────────────────────── */

export const thresholdTotalSchema = z.object({
  minTotalUyu: z.number().positive().max(10_000_000),
});

export const consecutiveOrdersSchema = z.object({
  windowMinutes: z.number().int().min(1).max(1440),
});

export const nthShipmentFreeSchema = z.object({
  nth: z.number().int().min(2).max(1000),
});

export const customerTagSchema = z.object({
  tag: z.string().trim().min(1).max(100),
});

export const itemCountSchema = z.object({
  minItems: z.number().int().min(1).max(100),
});

export const CONFIG_SCHEMA_BY_TYPE: Record<ShippingRuleType, z.ZodTypeAny> = {
  THRESHOLD_TOTAL: thresholdTotalSchema,
  CONSECUTIVE_ORDERS: consecutiveOrdersSchema,
  NTH_SHIPMENT_FREE: nthShipmentFreeSchema,
  CUSTOMER_TAG: customerTagSchema,
  ITEM_COUNT: itemCountSchema,
};

/**
 * Parse + validate a rule's config given its ruleType. Returns the typed
 * config on success, or a list of human-readable errors on failure.
 */
export function validateRuleConfig(
  ruleType: ShippingRuleType,
  config: unknown,
): { ok: true; config: unknown } | { ok: false; errors: string[] } {
  const schema = CONFIG_SCHEMA_BY_TYPE[ruleType];
  if (!schema) return { ok: false, errors: [`Unknown ruleType "${ruleType}"`] };
  const r = schema.safeParse(config);
  if (r.success) return { ok: true, config: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`),
  };
}

/* ─── Request schemas for the /api/v1/shipping-rules endpoints ────────────── */

export const createRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    ruleType: z.enum(SHIPPING_RULE_TYPES),
    config: z.unknown(),
    priority: z.number().int().min(0).max(10_000).default(100),
    isActive: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    const check = validateRuleConfig(v.ruleType, v.config);
    if (!check.ok) {
      for (const msg of check.errors) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ['config'] });
      }
    }
  });
export type CreateRuleInput = z.infer<typeof createRuleSchema>;

export const updateRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    ruleType: z.enum(SHIPPING_RULE_TYPES).optional(),
    config: z.unknown().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  // When ruleType or config changes, re-validate against the (possibly new) type.
  .superRefine((v, ctx) => {
    if (v.ruleType === undefined && v.config === undefined) return;
    if (v.ruleType === undefined) {
      // Config changed but type didn't — the API handler must validate against
      // the existing DB value, since we don't have it here.
      return;
    }
    if (v.config === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'config is required when ruleType changes',
        path: ['config'],
      });
      return;
    }
    const check = validateRuleConfig(v.ruleType, v.config);
    if (!check.ok) {
      for (const msg of check.errors) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg, path: ['config'] });
      }
    }
  });
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

export const reorderSchema = z.object({
  order: z.array(z.string().cuid()).min(1).max(100),
});
export type ReorderInput = z.infer<typeof reorderSchema>;

/* ─── Human-readable labels for the UI (stable; do not rely on enum.toString) */

export const RULE_TYPE_LABELS: Record<ShippingRuleType, string> = {
  THRESHOLD_TOTAL: 'Umbral de monto',
  CONSECUTIVE_ORDERS: 'Pedidos consecutivos',
  NTH_SHIPMENT_FREE: 'Envio gratis cada N',
  CUSTOMER_TAG: 'Etiqueta de cliente',
  ITEM_COUNT: 'Cantidad de items',
};

export const RULE_TYPE_DESCRIPTIONS: Record<ShippingRuleType, string> = {
  THRESHOLD_TOTAL: 'Si el total del pedido (convertido a UYU) supera el monto, la tienda paga el envio (REMITENTE).',
  CONSECUTIVE_ORDERS: 'Si el mismo cliente ya tiene un pedido dentro de la ventana, el nuevo va como REMITENTE.',
  NTH_SHIPMENT_FREE: 'Cada N-esimo envio al mismo cliente lo paga la tienda (REMITENTE).',
  CUSTOMER_TAG: 'Si el pedido o el cliente tiene la etiqueta en Shopify, se paga como REMITENTE.',
  ITEM_COUNT: 'Si el pedido tiene mas items que el minimo configurado, va como REMITENTE.',
};
