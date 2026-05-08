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
  type CompletedLabel,
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
