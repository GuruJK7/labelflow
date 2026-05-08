// Resilience guarantees for fulfillOrderWithTracking.
//
// Two failure modes the worker must handle differently from raw network errors:
//   1) Order already fulfilled (multi-tenant race or manual fulfillment) →
//      ShopifyAlreadyFulfilledError. Caller must downgrade to INFO/skip.
//   2) Custom App missing the four *_fulfillment_orders scopes →
//      ShopifyMissingScopesError. Caller must surface action items, not retry.
//
// Also covers: when the order's fulfillment_orders are all `closed`, that's
// effectively "already fulfilled" too — surface as ShopifyAlreadyFulfilledError.

import { describe, it, expect, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import {
  fulfillOrderWithTracking,
  ShopifyAlreadyFulfilledError,
  ShopifyMissingScopesError,
} from '../shopify/fulfillment';

type GetHandler = (path: string) => Promise<{ data: unknown }>;
type PostHandler = (path: string, body: unknown) => Promise<{ data: unknown }>;

function makeClient(opts: {
  get: GetHandler;
  post?: PostHandler;
}): AxiosInstance {
  return {
    get: vi.fn(opts.get),
    post: vi.fn(opts.post ?? (async () => ({ data: {} }))),
  } as unknown as AxiosInstance;
}

function axiosErr(status: number, body: unknown) {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: true;
    response: { status: number; data: unknown };
  };
  err.isAxiosError = true;
  err.response = { status, data: body };
  return err;
}

describe('fulfillOrderWithTracking — resilience', () => {
  it('throws ShopifyAlreadyFulfilledError when order.fulfillment_status = "fulfilled"', async () => {
    const client = makeClient({
      get: async (path) => {
        if (path.endsWith('/orders/123.json') || path === '/orders/123.json') {
          return { data: { order: { id: 123, fulfillment_status: 'fulfilled' } } };
        }
        throw new Error('unexpected GET ' + path);
      },
    });
    await expect(
      fulfillOrderWithTracking(client, 123, '8821111111111', undefined, false),
    ).rejects.toBeInstanceOf(ShopifyAlreadyFulfilledError);
  });

  it('throws ShopifyAlreadyFulfilledError when fulfillment_status = "partial"', async () => {
    const client = makeClient({
      get: async () => ({ data: { order: { id: 123, fulfillment_status: 'partial' } } }),
    });
    await expect(
      fulfillOrderWithTracking(client, 123, '8821111111111'),
    ).rejects.toMatchObject({ isAlreadyFulfilled: true, status: 'partial' });
  });

  it('throws ShopifyAlreadyFulfilledError when all fulfillment_orders are closed', async () => {
    const client = makeClient({
      get: async (path) => {
        if (path.includes('/fulfillment_orders.json')) {
          return { data: { fulfillment_orders: [{ id: 999, status: 'closed' }] } };
        }
        return { data: { order: { id: 123, fulfillment_status: null } } };
      },
    });
    await expect(
      fulfillOrderWithTracking(client, 123, '8821111111111'),
    ).rejects.toBeInstanceOf(ShopifyAlreadyFulfilledError);
  });

  it('throws ShopifyMissingScopesError on 403 from fulfillment_orders endpoint', async () => {
    const client = makeClient({
      get: async (path) => {
        if (path.includes('/fulfillment_orders.json')) {
          throw axiosErr(403, { errors: 'The api_client does not have the required permission(s).' });
        }
        return { data: { order: { id: 123, fulfillment_status: null } } };
      },
    });
    const err = await fulfillOrderWithTracking(client, 123, '8821111111111').catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyMissingScopesError);
    // The error message must contain the action items for the operator
    expect(err.message).toContain('read_assigned_fulfillment_orders');
    expect(err.message).toContain('Shopify Partners');
    expect(err.message).toContain('reinstall');
  });

  it('throws ShopifyMissingScopesError on 403 from POST /fulfillments.json', async () => {
    const client = makeClient({
      get: async (path) => {
        if (path.includes('/fulfillment_orders.json')) {
          return { data: { fulfillment_orders: [{ id: 555, status: 'open' }] } };
        }
        return { data: { order: { id: 123, fulfillment_status: null } } };
      },
      post: async () => {
        throw axiosErr(403, { errors: 'The api_client does not have the required permission(s).' });
      },
    });
    await expect(
      fulfillOrderWithTracking(client, 123, '8821111111111'),
    ).rejects.toBeInstanceOf(ShopifyMissingScopesError);
  });

  it('rejects PENDING- guias before any Shopify call', async () => {
    const client = makeClient({ get: async () => { throw new Error('should not be called'); } });
    await expect(
      fulfillOrderWithTracking(client, 123, 'PENDING-abc'),
    ).rejects.toThrow(/invalid guia/i);
  });

  it('happy path: posts fulfillment when status is null and fulfillment_orders are open', async () => {
    let posted: unknown = null;
    const client = makeClient({
      get: async (path) => {
        if (path.includes('/fulfillment_orders.json')) {
          return { data: { fulfillment_orders: [{ id: 555, status: 'open' }] } };
        }
        return { data: { order: { id: 123, fulfillment_status: null } } };
      },
      post: async (_path, body) => {
        posted = body;
        return { data: { fulfillment: { id: 999 } } };
      },
    });

    await fulfillOrderWithTracking(client, 123, '8821164616263', 'https://dac.com.uy/track?guia=8821164616263');
    expect(posted).toMatchObject({
      fulfillment: {
        line_items_by_fulfillment_order: [{ fulfillment_order_id: 555 }],
        tracking_info: { number: '8821164616263', company: 'Other' },
        notify_customer: true,
      },
    });
  });

  it('passes non-403 errors through unchanged (e.g. 500)', async () => {
    const client = makeClient({
      get: async (path) => {
        if (path.includes('/fulfillment_orders.json')) throw axiosErr(500, 'server error');
        return { data: { order: { id: 123, fulfillment_status: null } } };
      },
    });
    const err = await fulfillOrderWithTracking(client, 123, '8821111111111').catch((e) => e);
    expect(err).not.toBeInstanceOf(ShopifyAlreadyFulfilledError);
    expect(err).not.toBeInstanceOf(ShopifyMissingScopesError);
    expect(err.message).toMatch(/500/);
  });

  it('forceAll mode lets it accept in_progress / on_hold fulfillment_orders', async () => {
    let posted = false;
    const client = makeClient({
      get: async (path) => {
        if (path.includes('/fulfillment_orders.json')) {
          return { data: { fulfillment_orders: [{ id: 1, status: 'in_progress' }, { id: 2, status: 'on_hold' }] } };
        }
        return { data: { order: { id: 123, fulfillment_status: null } } };
      },
      post: async () => {
        posted = true;
        return { data: { fulfillment: { id: 999 } } };
      },
    });
    await fulfillOrderWithTracking(client, 123, '8821111111111', undefined, true);
    expect(posted).toBe(true);
  });
});
