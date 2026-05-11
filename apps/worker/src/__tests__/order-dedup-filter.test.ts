// Regression: cross-tenant duplicate-prevention filter.
//
// Incident: 2026-05-08, Aura shop (s0zgdy-1v.myshopify.com) had two tenants
// pointing at the same shop ("Alex" + "Nueva tienda"). The filter only looked
// at the CURRENT tenant's Labels, so when "Nueva tienda" got a working token
// and the cron ran, it didn't see "Alex"'s already-COMPLETED Labels for the
// same shop and would have re-billed DAC for those orders. Operator paused
// both tenants before the second cycle hit. This test pins the cross-tenant
// behavior so we never regress.

import { describe, it, expect } from 'vitest';
import {
  partitionByCompletedLabels,
  partitionByAIFeasibilityBounce,
  partitionByStuckPendingShipment,
  type CompletedLabel,
  type AIFeasibilityBounce,
  type StuckPendingShipment,
  type ShopifyOrderLike,
} from '../jobs/order-dedup-filter';

const T_NUEVA = 'cmox3tisc000isz6dynggyapt'; // current tenant in tests
const T_ALEX = 'cmoj8ezg3000482cfi428near';  // sibling tenant on same shop

function order(id: number, name: string): ShopifyOrderLike {
  return { id, name };
}

function label(orderId: string, tenantId: string, guia: string | null = '8821111111111'): CompletedLabel {
  return {
    shopifyOrderId: orderId,
    dacGuia: guia,
    updatedAt: new Date('2026-05-08T19:00:00Z'),
    tenantId,
  };
}

describe('partitionByCompletedLabels — cross-tenant dedup', () => {
  it('keeps orders with no matching Label in any tenant', () => {
    const orders = [order(1208, '#1208'), order(1209, '#1209')];
    const result = partitionByCompletedLabels(orders, [], T_NUEVA);
    expect(result.kept.map((o) => o.id)).toEqual([1208, 1209]);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips orders with a Label in the SAME tenant (existing same-tenant gate)', () => {
    const orders = [order(1243, '#1243'), order(1244, '#1244')];
    const completed = [label('1243', T_NUEVA, '8821164616263')];
    const result = partitionByCompletedLabels(orders, completed, T_NUEVA);
    expect(result.kept.map((o) => o.id)).toEqual([1244]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      orderName: '#1243',
      guia: '8821164616263',
      sameTenant: true,
    });
  });

  it('REGRESSION: skips orders with a Label in a DIFFERENT tenant on the same shop', () => {
    // Alex processed #1158. NuevaTienda tenant runs next. The filter must
    // skip #1158 even though NuevaTienda has no own Label for it — the DAC
    // guía already exists, and re-running would create a duplicate shipment.
    const orders = [order(1158, '#1158'), order(1209, '#1209')];
    const completed = [label('1158', T_ALEX, '8821163944073')];
    const result = partitionByCompletedLabels(orders, completed, T_NUEVA);
    expect(result.kept.map((o) => o.id)).toEqual([1209]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      orderName: '#1158',
      guia: '8821163944073',
      sameTenant: false, // ← cross-tenant flag for the runlog narrative
    });
  });

  it('flags sameTenant correctly when both same-tenant and cross-tenant skips occur', () => {
    const orders = [
      order(1158, '#1158'), // Alex's
      order(1243, '#1243'), // Nueva's
      order(1208, '#1208'), // fresh
    ];
    const completed = [
      label('1158', T_ALEX),
      label('1243', T_NUEVA),
    ];
    const result = partitionByCompletedLabels(orders, completed, T_NUEVA);
    expect(result.kept.map((o) => o.id)).toEqual([1208]);
    expect(result.skipped).toHaveLength(2);

    const byOrder = new Map(result.skipped.map((s) => [s.orderName, s]));
    expect(byOrder.get('#1158')!.sameTenant).toBe(false);
    expect(byOrder.get('#1243')!.sameTenant).toBe(true);
  });

  it('handles three-or-more tenants on the same shop', () => {
    const T_OTHER = 'thirdTenantId';
    const orders = [order(100, '#100'), order(200, '#200'), order(300, '#300')];
    const completed = [
      label('100', T_NUEVA),
      label('200', T_ALEX),
      label('300', T_OTHER),
    ];
    const result = partitionByCompletedLabels(orders, completed, T_NUEVA);
    expect(result.kept).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    const byOrder = new Map(result.skipped.map((s) => [s.orderName, s]));
    expect(byOrder.get('#100')!.sameTenant).toBe(true);
    expect(byOrder.get('#200')!.sameTenant).toBe(false);
    expect(byOrder.get('#300')!.sameTenant).toBe(false);
  });

  it('matches by string-coerced shopifyOrderId (Shopify returns numeric, DB stores string)', () => {
    // The DB stores shopifyOrderId as text (Prisma type), Shopify's GraphQL
    // returns numeric `id`. The filter must match across that boundary.
    const orders = [order(6962662178994, '#1243')];
    const completed = [label('6962662178994', T_NUEVA)];
    const result = partitionByCompletedLabels(orders, completed, T_NUEVA);
    expect(result.kept).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('preserves order in kept (so cron processing order is stable)', () => {
    const orders = [order(1, '#1'), order(2, '#2'), order(3, '#3'), order(4, '#4')];
    const completed = [label('2', T_NUEVA)];
    const result = partitionByCompletedLabels(orders, completed, T_NUEVA);
    expect(result.kept.map((o) => o.id)).toEqual([1, 3, 4]);
  });
});

// ── partitionByAIFeasibilityBounce — 2026-05-09 cost regression ──────────
//
// Incident: 1761 AI feasibility calls in 24h (~$8/day) burned re-evaluating
// the same NEEDS_REVIEW orders every 15-min cron tick. Same Shopify
// address1 → same AI verdict ("not shippable") → wasted spend. This filter
// skips those orders unless the operator edited the Shopify address (which
// is the only way the verdict could change). These tests pin the behavior so
// the cost regression doesn't recur AND so legitimate re-evaluations after
// an operator edit still flow through.

const AI_BOUNCE_MSG =
  'Dirección del cliente en Shopify no se pudo interpretar — contactar al cliente para corregirla y reprocesar.';

function bounce(
  orderId: string,
  tenantId: string,
  deliveryAddress: string,
  errorMessage: string = AI_BOUNCE_MSG,
): AIFeasibilityBounce {
  return {
    shopifyOrderId: orderId,
    deliveryAddress,
    errorMessage,
    updatedAt: new Date('2026-05-09T13:00:00Z'),
    tenantId,
  };
}

function addressMap(...entries: Array<[number, string]>): Map<string, string> {
  return new Map(entries.map(([id, addr]) => [String(id), addr]));
}

describe('partitionByAIFeasibilityBounce — AI cost regression', () => {
  it('keeps orders with no prior bounce (new orders, never bounced)', () => {
    const orders = [order(1208, '#1208'), order(1209, '#1209')];
    const result = partitionByAIFeasibilityBounce(
      orders,
      [],
      addressMap([1208, 'Av Italia 1234'], [1209, 'Brandsen 100']),
      T_NUEVA,
    );
    expect(result.kept.map((o) => o.id)).toEqual([1208, 1209]);
    expect(result.skipped).toHaveLength(0);
  });

  it('REGRESSION CORE: skips orders with same address1 as the prior AI bounce', () => {
    // Order #1240 was bounced yesterday with address "Ibicuy entre eguren y
    // lucas roselli". Customer hasn't changed it. Re-asking AI is wasted spend.
    const orders = [order(1240, '#1240'), order(1245, '#1245')];
    const bounces = [bounce('1240', T_NUEVA, 'Ibicuy entre eguren y lucas roselli')];
    const result = partitionByAIFeasibilityBounce(
      orders,
      bounces,
      addressMap(
        [1240, 'Ibicuy entre eguren y lucas roselli'], // unchanged
        [1245, 'Cisnes'],
      ),
      T_NUEVA,
    );
    expect(result.kept.map((o) => o.id)).toEqual([1245]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      orderName: '#1240',
      sameTenant: true,
    });
  });

  it('keeps orders whose Shopify address1 was edited since the bounce', () => {
    // Operator fixed #1240 in Shopify — now reads "Ibicuy 542". Should re-evaluate.
    const orders = [order(1240, '#1240')];
    const bounces = [bounce('1240', T_NUEVA, 'Ibicuy entre eguren y lucas roselli')];
    const result = partitionByAIFeasibilityBounce(
      orders,
      bounces,
      addressMap([1240, 'Ibicuy 542']),
      T_NUEVA,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('cross-tenant: skips when a sibling tenant on the same shop bounced this address', () => {
    // Aura shop has two tenants. Alex bounced #1240 yesterday. NuevaTienda
    // runs today — should still skip (same shop, same address, same verdict).
    const orders = [order(1240, '#1240')];
    const bounces = [bounce('1240', T_ALEX, 'Ibicuy entre eguren y lucas roselli')];
    const result = partitionByAIFeasibilityBounce(
      orders,
      bounces,
      addressMap([1240, 'Ibicuy entre eguren y lucas roselli']),
      T_NUEVA, // current tenant is NuevaTienda
    );
    expect(result.kept).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({
      orderName: '#1240',
      sameTenant: false, // bounce was from sibling tenant
    });
  });

  it('normalizes whitespace + casing — incidental edits do NOT trigger re-evaluation', () => {
    // Shopify or another integration capitalized the address differently.
    // We don't want to burn AI for that.
    const orders = [order(1240, '#1240')];
    const bounces = [bounce('1240', T_NUEVA, 'Ibicuy entre eguren y lucas roselli')];
    const result = partitionByAIFeasibilityBounce(
      orders,
      bounces,
      addressMap([1240, '  IBICUY ENTRE EGUREN Y   LUCAS ROSELLI  ']), // same content, diff whitespace/casing
      T_NUEVA,
    );
    expect(result.kept).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  it('handles empty current address gracefully (no crash, treats as "changed")', () => {
    // Edge case: order with no shipping_address.address1 in current Shopify
    // payload. We pass empty string — comparison fails → re-process (safe default).
    const orders = [order(1240, '#1240')];
    const bounces = [bounce('1240', T_NUEVA, 'Some Address 100')];
    const result = partitionByAIFeasibilityBounce(
      orders,
      bounces,
      addressMap([1240, '']),
      T_NUEVA,
    );
    expect(result.kept).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('accepts orders with no address entry in the map (defensive — treats as changed)', () => {
    const orders = [order(1240, '#1240')];
    const bounces = [bounce('1240', T_NUEVA, 'Some Address 100')];
    // Map deliberately empty — orderId 1240 not present
    const result = partitionByAIFeasibilityBounce(
      orders,
      bounces,
      new Map<string, string>(),
      T_NUEVA,
    );
    expect(result.kept).toHaveLength(1);
  });

  it('does NOT touch orders whose previous Label has a different reason (e.g. C-4 ORPHANED)', () => {
    // The caller is responsible for filtering bounces to AI-feasibility only.
    // If a bounce array includes a non-AI errorMessage it's a caller bug —
    // but the function still operates by address comparison, which is fine.
    // This test documents that the filter doesn't try to second-guess the
    // bounce list provided.
    const orders = [order(1240, '#1240')];
    const bounces = [bounce('1240', T_NUEVA, 'Some Address 100', 'C-4: prior submit exists')];
    const result = partitionByAIFeasibilityBounce(
      orders,
      bounces,
      addressMap([1240, 'Some Address 100']),
      T_NUEVA,
    );
    // Skipped because address matches — but the runlog from the caller will
    // show the C-4 reason verbatim so an operator can audit.
    expect(result.kept).toHaveLength(0);
    expect(result.skipped[0].reason).toContain('C-4');
  });

  it('preserves order ordering in kept (cron processing order stability)', () => {
    const orders = [order(1, '#1'), order(2, '#2'), order(3, '#3'), order(4, '#4')];
    const bounces = [bounce('2', T_NUEVA, 'Same Addr')];
    const result = partitionByAIFeasibilityBounce(
      orders,
      bounces,
      addressMap([1, 'A'], [2, 'Same Addr'], [3, 'C'], [4, 'D']),
      T_NUEVA,
    );
    expect(result.kept.map((o) => o.id)).toEqual([1, 3, 4]);
  });
});

// ── partitionByStuckPendingShipment — incident #11865-batch-starvation ────
//
// 2026-05-11 Nueva tienda incident: 5 orders stuck in ORPHANED status for
// ~66h kept filling all 5 slots of the batch cap every cron tick, returning
// 0 success / 5 failed every cycle. Real new orders never got a slot. The
// C-4 guard inside shipment.ts was doing its job (refusing to risk a
// duplicate guía) but the cron had no early-skip to free up batch capacity.
// This filter is that early-skip.

function stuckShipment(
  orderId: string,
  status: 'PENDING' | 'ORPHANED',
  ageHours: number,
  guia: string | null = null,
  now: number = Date.now(),
): StuckPendingShipment {
  return {
    shopifyOrderId: orderId,
    status,
    resolvedGuia: guia,
    submitAttemptedAt: new Date(now - ageHours * 3_600_000),
  };
}

describe('partitionByStuckPendingShipment — batch-starvation guard (incident 2026-05-11)', () => {
  const NOW = new Date('2026-05-11T17:00:00Z').getTime();

  it('keeps every order when no stuck PendingShipment exists', () => {
    const orders = [order(1100, '#1100'), order(1101, '#1101')];
    const result = partitionByStuckPendingShipment(orders, [], NOW);
    expect(result.kept.map((o) => o.id)).toEqual([1100, 1101]);
    expect(result.skipped).toEqual([]);
  });

  it('skips orders with ORPHANED PendingShipment (the production failure mode)', () => {
    const orders = [
      order(6913805222066, '#1191'),
      order(6932584071346, '#1207'),
      order(7000000000000, '#1300'), // new order — must still flow through
    ];
    const stuck: StuckPendingShipment[] = [
      stuckShipment('6913805222066', 'ORPHANED', 65.8, null, NOW),
      stuckShipment('6932584071346', 'ORPHANED', 65.8, null, NOW),
    ];
    const result = partitionByStuckPendingShipment(orders, stuck, NOW);
    expect(result.kept.map((o) => o.id)).toEqual([7000000000000]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.orderName).sort()).toEqual(['#1191', '#1207']);
    for (const s of result.skipped) {
      expect(s.status).toBe('ORPHANED');
      expect(s.guia).toBeNull();
      expect(s.ageMs / 3_600_000).toBeCloseTo(65.8, 1);
    }
  });

  it('skips orders with PENDING PendingShipment (worker crashed mid-Finalizar)', () => {
    const orders = [order(2000, '#2000')];
    const stuck: StuckPendingShipment[] = [
      stuckShipment('2000', 'PENDING', 0.5, null, NOW),
    ];
    const result = partitionByStuckPendingShipment(orders, stuck, NOW);
    expect(result.kept).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ orderName: '#2000', status: 'PENDING' });
  });

  it('forwards the guía when ORPHANED row has a guía linked (rare but possible)', () => {
    // ORPHANED with guía: rescue path adopted a guía but downstream PDF/
    // fulfillment marker failed. C-4 still blocks for safety until operator
    // reconciles. We surface the guía for operator visibility.
    const orders = [order(3000, '#3000')];
    const stuck: StuckPendingShipment[] = [
      stuckShipment('3000', 'ORPHANED', 12, '8821166614737', NOW),
    ];
    const result = partitionByStuckPendingShipment(orders, stuck, NOW);
    expect(result.kept).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      orderName: '#3000',
      status: 'ORPHANED',
      guia: '8821166614737',
    });
  });

  it('preserves order ordering in kept', () => {
    const orders = [order(1, '#1'), order(2, '#2'), order(3, '#3'), order(4, '#4')];
    const stuck: StuckPendingShipment[] = [
      stuckShipment('2', 'ORPHANED', 24, null, NOW),
    ];
    const result = partitionByStuckPendingShipment(orders, stuck, NOW);
    expect(result.kept.map((o) => o.id)).toEqual([1, 3, 4]);
  });

  it('age computation uses injected `now` (deterministic test)', () => {
    const orders = [order(1, '#1')];
    const stuck: StuckPendingShipment[] = [
      stuckShipment('1', 'ORPHANED', 24, null, NOW), // submitted 24h before NOW
    ];
    const result = partitionByStuckPendingShipment(orders, stuck, NOW);
    expect(result.skipped[0].ageMs).toBe(24 * 3_600_000);
  });

  it('empty orders array returns empty kept + empty skipped without throwing', () => {
    const result = partitionByStuckPendingShipment([], [], NOW);
    expect(result).toEqual({ kept: [], skipped: [] });
  });

  it('regression — Nueva tienda 5-order pile-up (exact production scenario)', () => {
    // The exact 5 orders that filled batch capacity on 2026-05-11. Validates
    // that all 5 get partitioned out and new orders ARE picked up.
    const stuckOrderIds = [
      '6913805222066', // #1191
      '6932584071346', // #1207
      '6955708448946', // #1214
      '6958300659890',
      '6965151596722',
    ];
    const stuck: StuckPendingShipment[] = stuckOrderIds.map((id) =>
      stuckShipment(id, 'ORPHANED', 60, null, NOW),
    );
    // Imagine 45 unfulfilled orders fetched from Shopify; the 5 stuck ones
    // come back at the top because they keep cycling on unfulfilled-list.
    const newerOrders = Array.from({ length: 8 }, (_, i) =>
      order(7000000000000 + i, `#NEW-${i}`),
    );
    const allOrders = [
      ...stuckOrderIds.map((id, i) => order(Number(id), `#STUCK-${i}`)),
      ...newerOrders,
    ];
    const result = partitionByStuckPendingShipment(allOrders, stuck, NOW);
    // All 5 stuck filtered out, 8 new orders kept (would have been starved).
    expect(result.kept).toHaveLength(8);
    expect(result.skipped).toHaveLength(5);
  });
});
