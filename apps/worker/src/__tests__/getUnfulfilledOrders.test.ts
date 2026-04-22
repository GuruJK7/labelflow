import { describe, it, expect, vi } from 'vitest';
import { getUnfulfilledOrders } from '../shopify/orders';
import type { AxiosInstance } from 'axios';
import type { ShopifyOrder } from '../shopify/types';

// Helper: build a mock ShopifyOrder with sensible defaults and overrides
function makeOrder(overrides: Partial<ShopifyOrder>): ShopifyOrder {
  return {
    id: 1,
    name: '#1',
    email: 'test@example.com',
    total_price: '100',
    currency: 'UYU',
    tags: '',
    shipping_address: null,
    line_items: [],
    note: null,
    note_attributes: null,
    ...overrides,
  };
}

// Helper: build a mock axios client that returns a canned orders payload
function makeClient(orders: ShopifyOrder[]): AxiosInstance {
  return {
    get: vi.fn().mockResolvedValue({ data: { orders } }),
  } as unknown as AxiosInstance;
}

describe('getUnfulfilledOrders — 2026-04-22 audit: tag/note filter removed', () => {
  it('returns orders with no tags or notes (fresh orders)', async () => {
    const orders = [
      makeOrder({ id: 1, name: '#1' }),
      makeOrder({ id: 2, name: '#2', tags: 'priority, gift' }),
    ];
    const client = makeClient(orders);
    const result = await getUnfulfilledOrders(client);
    expect(result).toHaveLength(2);
    expect(result.map((o) => o.id)).toEqual([1, 2]);
  });

  // ── Behavior change ──
  // Before: orders with "RASTREO ENVIADO" or "labelflow-procesado" tags were
  // filtered out, preventing reprocess after a manual Shopify unfulfill.
  // After: Shopify's fulfillment_status=unfulfilled is the single source of
  // truth. If Shopify says unfulfilled, we return it even if the tag/note
  // from a prior successful run is still on the order.

  it('returns orders tagged with "RASTREO ENVIADO" (operator unfulfilled to redo)', async () => {
    const orders = [
      makeOrder({
        id: 100,
        name: '#100',
        tags: 'RASTREO ENVIADO',
      }),
    ];
    const client = makeClient(orders);
    const result = await getUnfulfilledOrders(client);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(100);
  });

  it('returns orders tagged with legacy "labelflow-procesado"', async () => {
    const orders = [
      makeOrder({
        id: 101,
        name: '#101',
        tags: 'labelflow-procesado',
      }),
    ];
    const client = makeClient(orders);
    const result = await getUnfulfilledOrders(client);
    expect(result).toHaveLength(1);
  });

  it('returns orders whose note still contains "LabelFlow-GUIA:" (prior run stamp)', async () => {
    const orders = [
      makeOrder({
        id: 102,
        name: '#102',
        note: 'LabelFlow-GUIA: 8821124123456 | 2026-04-22T10:00:00Z',
      }),
    ];
    const client = makeClient(orders);
    const result = await getUnfulfilledOrders(client);
    expect(result).toHaveLength(1);
  });

  it('returns orders with BOTH tag and note from a prior run', async () => {
    const orders = [
      makeOrder({
        id: 103,
        name: '#103',
        tags: 'RASTREO ENVIADO, priority',
        note: 'LabelFlow-GUIA: 8821124000000 | 2026-04-21T20:00:00Z',
      }),
    ];
    const client = makeClient(orders);
    const result = await getUnfulfilledOrders(client);
    expect(result).toHaveLength(1);
  });

  it('returns all orders (does NOT filter by tag) — case-insensitive tag match does not skip', async () => {
    const orders = [
      makeOrder({ id: 1, name: '#1', tags: 'rastreo enviado' }),
      makeOrder({ id: 2, name: '#2', tags: 'RASTREO ENVIADO' }),
      makeOrder({ id: 3, name: '#3', tags: 'Rastreo Enviado' }),
      makeOrder({ id: 4, name: '#4', tags: '' }),
    ];
    const client = makeClient(orders);
    const result = await getUnfulfilledOrders(client);
    expect(result).toHaveLength(4);
  });

  it('passes the correct Shopify query params (status/fulfillment_status/order)', async () => {
    const client = makeClient([]);
    await getUnfulfilledOrders(client, 'newest_first');
    expect(client.get).toHaveBeenCalledWith('/orders.json', {
      params: {
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        status: 'open',
        limit: 250,
        order: 'created_at desc',
      },
    });
  });

  it('defaults to oldest_first sort when direction is not specified', async () => {
    const client = makeClient([]);
    await getUnfulfilledOrders(client);
    expect(client.get).toHaveBeenCalledWith(
      '/orders.json',
      expect.objectContaining({
        params: expect.objectContaining({ order: 'created_at asc' }),
      }),
    );
  });

  it('handles empty response gracefully', async () => {
    const client = makeClient([]);
    const result = await getUnfulfilledOrders(client);
    expect(result).toEqual([]);
  });

  it('handles missing orders field in response', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as AxiosInstance;
    const result = await getUnfulfilledOrders(client);
    expect(result).toEqual([]);
  });
});
