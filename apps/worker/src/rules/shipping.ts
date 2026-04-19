/**
 * shipping.ts — first-match-wins rule engine for REMITENTE vs DESTINATARIO.
 *
 * An ordered list of `ShippingRule` rows per tenant decides whether a given
 * Shopify order ships at the store's expense (REMITENTE, store's DAC account
 * gets debited) or C.O.D. (DESTINATARIO, customer pays on delivery).
 *
 * Evaluation:
 *   - Rules are sorted by `priority` ASC, then `createdAt` ASC for stable order.
 *   - Only `isActive=true` rules are considered.
 *   - Each rule type has its own matcher function; the first one that returns
 *     true causes the engine to short-circuit and return 'REMITENTE'.
 *   - If no rule matches (or no rules exist), `evaluateShippingRules` returns
 *     `null` and the caller falls back to the legacy `determinePaymentType`
 *     + consolidation logic so existing tenants keep working unchanged.
 *
 * This module is the single source of truth for rule evaluation; the web app
 * imports `RULE_CONFIG_SCHEMAS` for runtime validation on save and for the
 * dashboard UI.
 */

import type { ShopifyOrder } from '../shopify/types';
import type { PrismaClient } from '@prisma/client';
import logger from '../logger';

/* ─── Types mirrored from the Prisma enum so the worker can work without
 *     importing the generated client types (which vary across packages). */

export type ShippingRuleType =
  | 'THRESHOLD_TOTAL'
  | 'CONSECUTIVE_ORDERS'
  | 'NTH_SHIPMENT_FREE'
  | 'CUSTOMER_TAG'
  | 'ITEM_COUNT';

export interface ShippingRuleRow {
  id: string;
  tenantId: string;
  name: string;
  ruleType: ShippingRuleType;
  config: unknown; // Json — validated per-type at evaluation time
  priority: number;
  isActive: boolean;
}

/* ─── Per-rule config shapes + validators ─────────────────────────────────── */

export interface ThresholdTotalConfig {
  minTotalUyu: number; // strict greater-than
}
export interface ConsecutiveOrdersConfig {
  windowMinutes: number; // look-back window for same-customer prior orders
}
export interface NthShipmentFreeConfig {
  nth: number; // every Nth shipment (>=2) to same customer → REMITENTE
}
export interface CustomerTagConfig {
  tag: string; // matched case-insensitively against order.tags (CSV) or customer tags
}
export interface ItemCountConfig {
  minItems: number; // strict greater-than line_items.length
}

export type AnyRuleConfig =
  | ThresholdTotalConfig
  | ConsecutiveOrdersConfig
  | NthShipmentFreeConfig
  | CustomerTagConfig
  | ItemCountConfig;

/**
 * Runtime validators — returns null if valid, or a string error if not.
 * Kept cheap so the UI can run them in the browser too (no Node-only deps).
 */
export const RULE_CONFIG_SCHEMAS: Record<
  ShippingRuleType,
  (c: unknown) => string | null
> = {
  THRESHOLD_TOTAL: (c) => {
    if (!c || typeof c !== 'object') return 'config must be an object';
    const v = c as Partial<ThresholdTotalConfig>;
    if (typeof v.minTotalUyu !== 'number' || !Number.isFinite(v.minTotalUyu) || v.minTotalUyu <= 0)
      return 'minTotalUyu must be a positive number';
    return null;
  },
  CONSECUTIVE_ORDERS: (c) => {
    if (!c || typeof c !== 'object') return 'config must be an object';
    const v = c as Partial<ConsecutiveOrdersConfig>;
    if (typeof v.windowMinutes !== 'number' || !Number.isInteger(v.windowMinutes) || v.windowMinutes < 1 || v.windowMinutes > 1440)
      return 'windowMinutes must be an integer 1..1440';
    return null;
  },
  NTH_SHIPMENT_FREE: (c) => {
    if (!c || typeof c !== 'object') return 'config must be an object';
    const v = c as Partial<NthShipmentFreeConfig>;
    if (typeof v.nth !== 'number' || !Number.isInteger(v.nth) || v.nth < 2 || v.nth > 1000)
      return 'nth must be an integer 2..1000';
    return null;
  },
  CUSTOMER_TAG: (c) => {
    if (!c || typeof c !== 'object') return 'config must be an object';
    const v = c as Partial<CustomerTagConfig>;
    if (typeof v.tag !== 'string' || v.tag.trim().length === 0 || v.tag.length > 100)
      return 'tag must be a non-empty string (max 100 chars)';
    return null;
  },
  ITEM_COUNT: (c) => {
    if (!c || typeof c !== 'object') return 'config must be an object';
    const v = c as Partial<ItemCountConfig>;
    if (typeof v.minItems !== 'number' || !Number.isInteger(v.minItems) || v.minItems < 1 || v.minItems > 100)
      return 'minItems must be an integer 1..100';
    return null;
  },
};

/* ─── Exchange rates — kept in sync with rules/payment.ts ─────────────────── */

const EXCHANGE_RATES_TO_UYU: Record<string, number> = {
  UYU: 1,
  USD: 43,
  EUR: 47,
  ARS: 0.04,
  BRL: 8,
};

function orderTotalUyu(order: ShopifyOrder): number {
  const raw = parseFloat(order.total_price);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const currency = order.currency ?? 'UYU';
  const rate = EXCHANGE_RATES_TO_UYU[currency];
  if (!rate) return 0; // unknown currency — signal "cannot evaluate"
  return raw * rate;
}

/* ─── Evaluation context + matchers ───────────────────────────────────────── */

export interface EvaluationContext {
  order: ShopifyOrder;
  tenantId: string;
  db: PrismaClient;
}

type Matcher = (
  cfg: unknown,
  ctx: EvaluationContext,
) => Promise<boolean> | boolean;

function parseOrderTags(order: ShopifyOrder): string[] {
  const raw = (order as unknown as { tags?: string | string[] }).tags;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => t.trim().toLowerCase()).filter(Boolean);
  return String(raw)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function parseCustomerTags(order: ShopifyOrder): string[] {
  const customer = (order as unknown as { customer?: { tags?: string | string[] } }).customer;
  const raw = customer?.tags;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => t.trim().toLowerCase()).filter(Boolean);
  return String(raw)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

const MATCHERS: Record<ShippingRuleType, Matcher> = {
  THRESHOLD_TOTAL: (cfg, { order }) => {
    const c = cfg as ThresholdTotalConfig;
    const totalUyu = orderTotalUyu(order);
    if (totalUyu <= 0) return false; // unknown currency / bad total — conservative: don't match
    return totalUyu > c.minTotalUyu;
  },

  CONSECUTIVE_ORDERS: async (cfg, { order, tenantId, db }) => {
    const c = cfg as ConsecutiveOrdersConfig;
    if (!order.email) return false;
    const windowStart = new Date(Date.now() - c.windowMinutes * 60_000);
    const prior = await db.label.findFirst({
      where: {
        tenantId,
        customerEmail: order.email,
        status: { in: ['PENDING', 'COMPLETED', 'CREATED'] },
        shopifyOrderId: { not: String(order.id) },
        createdAt: { gte: windowStart },
      },
      select: { id: true },
    });
    return !!prior;
  },

  NTH_SHIPMENT_FREE: async (cfg, { order, tenantId, db }) => {
    const c = cfg as NthShipmentFreeConfig;
    if (!order.email) return false;
    // Count prior COMPLETED/CREATED labels for this customer. +1 for the
    // current order-in-flight. If that sum is an exact multiple of `nth`,
    // the current shipment is "the Nth" and goes free.
    const priorCount = await db.label.count({
      where: {
        tenantId,
        customerEmail: order.email,
        status: { in: ['COMPLETED', 'CREATED'] },
        shopifyOrderId: { not: String(order.id) },
      },
    });
    const currentPosition = priorCount + 1;
    return currentPosition % c.nth === 0;
  },

  CUSTOMER_TAG: (cfg, { order }) => {
    const c = cfg as CustomerTagConfig;
    const needle = c.tag.trim().toLowerCase();
    if (!needle) return false;
    const orderTags = parseOrderTags(order);
    const customerTags = parseCustomerTags(order);
    return orderTags.includes(needle) || customerTags.includes(needle);
  },

  ITEM_COUNT: (cfg, { order }) => {
    const c = cfg as ItemCountConfig;
    const items = (order as unknown as { line_items?: unknown[] }).line_items ?? [];
    return items.length > c.minItems;
  },
};

/* ─── Public entrypoint ────────────────────────────────────────────────────── */

export interface EvaluationResult {
  paymentType: 'REMITENTE' | null; // null = no rule matched, caller uses legacy path
  matchedRule?: {
    id: string;
    name: string;
    ruleType: ShippingRuleType;
  };
}

/**
 * Evaluate `rules` in priority order for the given order. Returns
 * `{ paymentType: 'REMITENTE', matchedRule }` on the first match, or
 * `{ paymentType: null }` if nothing matched.
 *
 * Callers MUST still handle the `null` case — typically by deferring to the
 * legacy `determinePaymentType(...)` path so tenants without rules keep their
 * existing behavior.
 */
export async function evaluateShippingRules(
  rules: ShippingRuleRow[],
  ctx: EvaluationContext,
): Promise<EvaluationResult> {
  if (!rules || rules.length === 0) {
    return { paymentType: null };
  }

  const sorted = [...rules]
    .filter((r) => r.isActive)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    const matcher = MATCHERS[rule.ruleType];
    if (!matcher) {
      logger.warn({ ruleId: rule.id, ruleType: rule.ruleType }, 'Unknown ruleType — skipping');
      continue;
    }
    // Defensive per-type validation. An invalid config never matches.
    const validator = RULE_CONFIG_SCHEMAS[rule.ruleType];
    const err = validator(rule.config);
    if (err) {
      logger.warn(
        { ruleId: rule.id, ruleType: rule.ruleType, configError: err },
        'ShippingRule has invalid config — skipping',
      );
      continue;
    }
    try {
      const matched = await matcher(rule.config, ctx);
      if (matched) {
        logger.info(
          {
            orderId: ctx.order.id,
            ruleId: rule.id,
            ruleName: rule.name,
            ruleType: rule.ruleType,
          },
          'ShippingRule matched → REMITENTE',
        );
        return {
          paymentType: 'REMITENTE',
          matchedRule: { id: rule.id, name: rule.name, ruleType: rule.ruleType },
        };
      }
    } catch (err) {
      // A rule throwing should never crash the job. Log and continue to next.
      logger.warn(
        {
          ruleId: rule.id,
          ruleType: rule.ruleType,
          err: (err as Error).message,
        },
        'ShippingRule matcher threw — skipping',
      );
    }
  }

  return { paymentType: null };
}
