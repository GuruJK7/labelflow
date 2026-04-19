/**
 * Unit tests for the ShippingRule evaluator.
 *
 * The evaluator short-circuits on the first active rule that matches, in
 * priority ASC order. These tests lock in:
 *   - priority ordering
 *   - isActive filtering
 *   - per-type matcher semantics (including strict-greater-than edges)
 *   - config validation (bad configs must NEVER match)
 *   - DB-backed matchers (CONSECUTIVE_ORDERS, NTH_SHIPMENT_FREE) with an
 *     in-memory mock db so tests don't need a live Postgres.
 *   - resilience: a throwing matcher must not crash the loop.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateShippingRules,
  RULE_CONFIG_SCHEMAS,
  type ShippingRuleRow,
  type EvaluationContext,
} from '../rules/shipping';
import type { PrismaClient } from '@prisma/client';

/* ─── Test helpers ───────────────────────────────────────────────────────── */

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 999,
    name: '#TEST',
    total_price: '5000',
    currency: 'UYU',
    email: 'buyer@example.com',
    line_items: [{ id: 1 }, { id: 2 }],
    ...overrides,
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface LabelRecord {
  id: string;
  tenantId: string;
  customerEmail: string | null;
  status: string;
  shopifyOrderId: string;
  createdAt: Date;
}

/**
 * Minimal PrismaClient mock covering just the two queries the evaluator uses.
 * We only implement the `label.findFirst` and `label.count` shapes with the
 * specific `where` clauses the matchers pass in.
 */
function makeMockDb(labels: LabelRecord[]): PrismaClient {
  const matches = (where: Record<string, unknown>, row: LabelRecord) => {
    if (where.tenantId && row.tenantId !== where.tenantId) return false;
    if (where.customerEmail && row.customerEmail !== where.customerEmail) return false;
    const status = where.status as { in?: string[] } | undefined;
    if (status?.in && !status.in.includes(row.status)) return false;
    const sid = where.shopifyOrderId as { not?: string } | undefined;
    if (sid?.not && row.shopifyOrderId === sid.not) return false;
    const ca = where.createdAt as { gte?: Date } | undefined;
    if (ca?.gte && row.createdAt < ca.gte) return false;
    return true;
  };

  return {
    label: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        labels.find((r) => matches(where, r)) ?? null,
      count: async ({ where }: { where: Record<string, unknown> }) =>
        labels.filter((r) => matches(where, r)).length,
    },
  } as unknown as PrismaClient;
}

const TENANT = 'tenant-1';
const baseCtx = (order = makeOrder(), db: PrismaClient = makeMockDb([])): EvaluationContext => ({
  order,
  tenantId: TENANT,
  db,
});

function rule(partial: Partial<ShippingRuleRow>): ShippingRuleRow {
  return {
    id: partial.id ?? 'r1',
    tenantId: TENANT,
    name: partial.name ?? 'Test rule',
    ruleType: partial.ruleType ?? 'THRESHOLD_TOTAL',
    config: partial.config ?? { minTotalUyu: 4000 },
    priority: partial.priority ?? 100,
    isActive: partial.isActive ?? true,
  };
}

/* ─── Tests ──────────────────────────────────────────────────────────────── */

describe('evaluateShippingRules — basic behavior', () => {
  it('returns null when there are no rules', async () => {
    const res = await evaluateShippingRules([], baseCtx());
    expect(res.paymentType).toBeNull();
  });

  it('returns null when no rule matches', async () => {
    const rules = [rule({ config: { minTotalUyu: 9_999_999 } })];
    const res = await evaluateShippingRules(rules, baseCtx(makeOrder({ total_price: '100' })));
    expect(res.paymentType).toBeNull();
  });

  it('skips inactive rules even if they would match', async () => {
    const rules = [
      rule({ id: 'a', isActive: false, config: { minTotalUyu: 1 }, priority: 1 }),
      rule({ id: 'b', config: { minTotalUyu: 9_999_999 }, priority: 2 }),
    ];
    const res = await evaluateShippingRules(rules, baseCtx(makeOrder({ total_price: '5000' })));
    expect(res.paymentType).toBeNull();
  });
});

describe('priority + first-match-wins', () => {
  it('evaluates in priority ASC order', async () => {
    const rules = [
      rule({ id: 'low', priority: 200, config: { minTotalUyu: 1 }, name: 'Low' }),
      rule({ id: 'high', priority: 50, config: { minTotalUyu: 9_999_999 }, name: 'High' }),
    ];
    // high priority (50) runs first but its threshold is too high → doesn't match.
    // low priority (200) then matches.
    const res = await evaluateShippingRules(rules, baseCtx(makeOrder({ total_price: '5000' })));
    expect(res.paymentType).toBe('REMITENTE');
    expect(res.matchedRule?.id).toBe('low');
  });

  it('returns the FIRST rule that matches and stops', async () => {
    const rules = [
      rule({ id: 'first', priority: 10, config: { minTotalUyu: 1 }, name: 'First' }),
      rule({ id: 'second', priority: 20, config: { minTotalUyu: 1 }, name: 'Second' }),
    ];
    const res = await evaluateShippingRules(rules, baseCtx(makeOrder({ total_price: '5000' })));
    expect(res.matchedRule?.id).toBe('first');
  });
});

describe('THRESHOLD_TOTAL', () => {
  it('matches when UYU total is strictly greater than minTotalUyu', async () => {
    const r = rule({ ruleType: 'THRESHOLD_TOTAL', config: { minTotalUyu: 4000 } });
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ total_price: '4001' })));
    expect(res.paymentType).toBe('REMITENTE');
  });

  it('does NOT match at exact boundary', async () => {
    const r = rule({ ruleType: 'THRESHOLD_TOTAL', config: { minTotalUyu: 4000 } });
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ total_price: '4000' })));
    expect(res.paymentType).toBeNull();
  });

  it('converts USD to UYU using embedded rate (43)', async () => {
    const r = rule({ ruleType: 'THRESHOLD_TOTAL', config: { minTotalUyu: 4000 } });
    // $100 USD * 43 = 4300 UYU > 4000 → match
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ total_price: '100', currency: 'USD' })));
    expect(res.paymentType).toBe('REMITENTE');
  });

  it('does not match when currency is unknown (conservative)', async () => {
    const r = rule({ ruleType: 'THRESHOLD_TOTAL', config: { minTotalUyu: 1 } });
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ total_price: '9999', currency: 'XXX' })));
    expect(res.paymentType).toBeNull();
  });
});

describe('ITEM_COUNT', () => {
  it('matches when line_items length is strictly greater than minItems', async () => {
    const r = rule({ ruleType: 'ITEM_COUNT', config: { minItems: 2 } });
    const res = await evaluateShippingRules(
      [r],
      baseCtx(makeOrder({ line_items: [{}, {}, {}] })),
    );
    expect(res.paymentType).toBe('REMITENTE');
  });

  it('does NOT match at exact boundary', async () => {
    const r = rule({ ruleType: 'ITEM_COUNT', config: { minItems: 2 } });
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ line_items: [{}, {}] })));
    expect(res.paymentType).toBeNull();
  });
});

describe('CUSTOMER_TAG', () => {
  it('matches order.tags (CSV) case-insensitively', async () => {
    const r = rule({ ruleType: 'CUSTOMER_TAG', config: { tag: 'vip' } });
    const res = await evaluateShippingRules(
      [r],
      baseCtx(makeOrder({ tags: 'wholesale, VIP, repeat' })),
    );
    expect(res.paymentType).toBe('REMITENTE');
  });

  it('matches order.tags (array)', async () => {
    const r = rule({ ruleType: 'CUSTOMER_TAG', config: { tag: 'vip' } });
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ tags: ['VIP'] })));
    expect(res.paymentType).toBe('REMITENTE');
  });

  it('matches customer.tags when order has none', async () => {
    const r = rule({ ruleType: 'CUSTOMER_TAG', config: { tag: 'vip' } });
    const res = await evaluateShippingRules(
      [r],
      baseCtx(makeOrder({ tags: '', customer: { tags: 'vip' } })),
    );
    expect(res.paymentType).toBe('REMITENTE');
  });

  it('does NOT match when tag is absent', async () => {
    const r = rule({ ruleType: 'CUSTOMER_TAG', config: { tag: 'vip' } });
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ tags: 'retail' })));
    expect(res.paymentType).toBeNull();
  });
});

describe('CONSECUTIVE_ORDERS', () => {
  it('matches when a prior label exists for same email within window', async () => {
    const r = rule({ ruleType: 'CONSECUTIVE_ORDERS', config: { windowMinutes: 60 } });
    const db = makeMockDb([
      {
        id: 'L1',
        tenantId: TENANT,
        customerEmail: 'buyer@example.com',
        status: 'COMPLETED',
        shopifyOrderId: '555', // different from current order id
        createdAt: new Date(Date.now() - 10 * 60_000), // 10 min ago
      },
    ]);
    const res = await evaluateShippingRules([r], baseCtx(makeOrder(), db));
    expect(res.paymentType).toBe('REMITENTE');
  });

  it('does NOT match when the only prior label is outside the window', async () => {
    const r = rule({ ruleType: 'CONSECUTIVE_ORDERS', config: { windowMinutes: 60 } });
    const db = makeMockDb([
      {
        id: 'L1',
        tenantId: TENANT,
        customerEmail: 'buyer@example.com',
        status: 'COMPLETED',
        shopifyOrderId: '555',
        createdAt: new Date(Date.now() - 120 * 60_000), // 2 hours ago
      },
    ]);
    const res = await evaluateShippingRules([r], baseCtx(makeOrder(), db));
    expect(res.paymentType).toBeNull();
  });

  it('does NOT match when order has no email', async () => {
    const r = rule({ ruleType: 'CONSECUTIVE_ORDERS', config: { windowMinutes: 60 } });
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ email: undefined })));
    expect(res.paymentType).toBeNull();
  });

  it('ignores the current order when finding "prior" labels', async () => {
    const r = rule({ ruleType: 'CONSECUTIVE_ORDERS', config: { windowMinutes: 60 } });
    const order = makeOrder({ id: 999 });
    const db = makeMockDb([
      {
        id: 'L_same',
        tenantId: TENANT,
        customerEmail: 'buyer@example.com',
        status: 'COMPLETED',
        shopifyOrderId: '999', // same as current
        createdAt: new Date(),
      },
    ]);
    const res = await evaluateShippingRules([r], baseCtx(order, db));
    expect(res.paymentType).toBeNull();
  });
});

describe('NTH_SHIPMENT_FREE', () => {
  it('matches when priorCount + 1 is divisible by nth', async () => {
    const r = rule({ ruleType: 'NTH_SHIPMENT_FREE', config: { nth: 3 } });
    // 2 prior completed + 1 current = 3rd shipment → match
    const db = makeMockDb([
      {
        id: 'L1',
        tenantId: TENANT,
        customerEmail: 'buyer@example.com',
        status: 'COMPLETED',
        shopifyOrderId: '111',
        createdAt: new Date(),
      },
      {
        id: 'L2',
        tenantId: TENANT,
        customerEmail: 'buyer@example.com',
        status: 'CREATED',
        shopifyOrderId: '222',
        createdAt: new Date(),
      },
    ]);
    const res = await evaluateShippingRules([r], baseCtx(makeOrder(), db));
    expect(res.paymentType).toBe('REMITENTE');
  });

  it('does NOT match on non-multiple positions', async () => {
    const r = rule({ ruleType: 'NTH_SHIPMENT_FREE', config: { nth: 3 } });
    // 0 prior → position 1; 1 % 3 !== 0
    const res = await evaluateShippingRules([r], baseCtx(makeOrder(), makeMockDb([])));
    expect(res.paymentType).toBeNull();
  });

  it('does NOT match when order has no email', async () => {
    const r = rule({ ruleType: 'NTH_SHIPMENT_FREE', config: { nth: 2 } });
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ email: undefined })));
    expect(res.paymentType).toBeNull();
  });
});

describe('defensive behavior', () => {
  it('skips rules with invalid config (never matches)', async () => {
    const r = rule({ ruleType: 'THRESHOLD_TOTAL', config: { minTotalUyu: -1 } }); // invalid
    const res = await evaluateShippingRules([r], baseCtx(makeOrder({ total_price: '100000' })));
    expect(res.paymentType).toBeNull();
  });

  it('skips rules with unknown ruleType', async () => {
    const r = rule({ ruleType: 'NOT_A_REAL_TYPE' as any, config: {} }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await evaluateShippingRules([r], baseCtx());
    expect(res.paymentType).toBeNull();
  });

  it('does not crash when a matcher throws; continues to next rule', async () => {
    // A CONSECUTIVE_ORDERS rule with a db that throws — engine must log and
    // continue to the second rule, which does match.
    const brokenDb = {
      label: {
        findFirst: async () => {
          throw new Error('db down');
        },
        count: async () => 0,
      },
    } as unknown as PrismaClient;

    const rules = [
      rule({ id: 'broken', priority: 1, ruleType: 'CONSECUTIVE_ORDERS', config: { windowMinutes: 60 } }),
      rule({ id: 'good', priority: 2, ruleType: 'THRESHOLD_TOTAL', config: { minTotalUyu: 1 } }),
    ];
    const res = await evaluateShippingRules(
      rules,
      baseCtx(makeOrder({ total_price: '9999' }), brokenDb),
    );
    expect(res.paymentType).toBe('REMITENTE');
    expect(res.matchedRule?.id).toBe('good');
  });
});

/* ─── Standalone validator tests (schema round-trips) ────────────────────── */

describe('RULE_CONFIG_SCHEMAS', () => {
  it('accepts well-formed configs for every rule type', () => {
    expect(RULE_CONFIG_SCHEMAS.THRESHOLD_TOTAL({ minTotalUyu: 1 })).toBeNull();
    expect(RULE_CONFIG_SCHEMAS.CONSECUTIVE_ORDERS({ windowMinutes: 30 })).toBeNull();
    expect(RULE_CONFIG_SCHEMAS.NTH_SHIPMENT_FREE({ nth: 5 })).toBeNull();
    expect(RULE_CONFIG_SCHEMAS.CUSTOMER_TAG({ tag: 'vip' })).toBeNull();
    expect(RULE_CONFIG_SCHEMAS.ITEM_COUNT({ minItems: 1 })).toBeNull();
  });

  it('rejects wrong types and out-of-range values', () => {
    expect(RULE_CONFIG_SCHEMAS.THRESHOLD_TOTAL({ minTotalUyu: 0 })).toMatch(/positive/);
    expect(RULE_CONFIG_SCHEMAS.CONSECUTIVE_ORDERS({ windowMinutes: 0 })).toMatch(/1\.\.1440/);
    expect(RULE_CONFIG_SCHEMAS.CONSECUTIVE_ORDERS({ windowMinutes: 2000 })).toMatch(/1\.\.1440/);
    expect(RULE_CONFIG_SCHEMAS.NTH_SHIPMENT_FREE({ nth: 1 })).toMatch(/2\.\.1000/);
    expect(RULE_CONFIG_SCHEMAS.CUSTOMER_TAG({ tag: '' })).toMatch(/non-empty/);
    expect(RULE_CONFIG_SCHEMAS.ITEM_COUNT({ minItems: 0 })).toMatch(/1\.\.100/);
  });

  it('rejects non-object configs', () => {
    for (const type of Object.keys(RULE_CONFIG_SCHEMAS) as Array<keyof typeof RULE_CONFIG_SCHEMAS>) {
      expect(RULE_CONFIG_SCHEMAS[type](null)).toMatch(/object/);
      expect(RULE_CONFIG_SCHEMAS[type]('bad')).toMatch(/object/);
    }
  });
});
