// D27: fulfillment por GraphQL — fulfillmentOrders → fulfillmentCreate con
// trackingInfo, mismos errores tipados que fulfillment.ts.
import { describe, it, expect, vi } from 'vitest';
import {
  fulfillOrderWithTracking,
  FULFILLMENT_ORDERS_QUERY,
  FULFILLMENT_CREATE_MUTATION,
} from '../shopify/fulfillment-graphql';
import { ShopifyAlreadyFulfilledError, ShopifyMissingScopesError } from '../shopify/fulfillment';
import { ShopifyGraphqlError, type ShopifyGraphqlClient } from '../shopify/graphql-client';

type Handler = (query: string, variables: Record<string, unknown>) => Promise<unknown> | unknown;

function makeClient(handler: Handler) {
  const request = vi.fn(async (q: string, v: Record<string, unknown> = {}) => handler(q, v));
  const client = { storeUrl: 'qa.myshopify.com', apiVersion: '2026-07', request, lastCost: null, lastErrors: [] } as unknown as ShopifyGraphqlClient;
  return { client, request };
}

const FO_OPEN = { id: 'gid://shopify/FulfillmentOrder/7001', status: 'OPEN', requestStatus: 'UNSUBMITTED' };
const FO_CLOSED = { id: 'gid://shopify/FulfillmentOrder/7002', status: 'CLOSED', requestStatus: 'UNSUBMITTED' };
const FO_ON_HOLD = { id: 'gid://shopify/FulfillmentOrder/7003', status: 'ON_HOLD', requestStatus: 'UNSUBMITTED' };

function orderData(displayFulfillmentStatus: string, fos: unknown[]) {
  return {
    order: { id: 'gid://shopify/Order/123', legacyResourceId: '123', displayFulfillmentStatus, fulfillmentOrders: { nodes: fos } },
  };
}

const created = { fulfillmentCreate: { fulfillment: { id: 'gid://shopify/Fulfillment/555', legacyResourceId: '555', status: 'SUCCESS' }, userErrors: [] } };

describe('fulfillOrderWithTracking (GraphQL)', () => {
  it('flujo feliz: query de FO por GID y mutation con lineItemsByFulfillmentOrder + trackingInfo + notifyCustomer', async () => {
    const { client, request } = makeClient((q) => (q === FULFILLMENT_ORDERS_QUERY ? orderData('UNFULFILLED', [FO_OPEN, FO_CLOSED]) : created));
    await fulfillOrderWithTracking(client, 123, '8821238402641', 'https://www.dac.com.uy/track/8821238402641');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual([FULFILLMENT_ORDERS_QUERY, { id: 'gid://shopify/Order/123' }]);
    expect(request.mock.calls[1][0]).toBe(FULFILLMENT_CREATE_MUTATION);
    expect(request.mock.calls[1][1]).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/7001' }],
        trackingInfo: { number: '8821238402641', url: 'https://www.dac.com.uy/track/8821238402641', company: 'Other' },
        notifyCustomer: true,
      },
    });
  });

  it('sin URL de DAC arma el fallback de rastreo; con sinUrl omite `url` y usa la company indicada', async () => {
    const { request } = await (async () => {
      const c = makeClient((q) => (q === FULFILLMENT_ORDERS_QUERY ? orderData('UNFULFILLED', [FO_OPEN]) : created));
      await fulfillOrderWithTracking(c.client, 123, 'G 1');
      return c;
    })();
    expect((request.mock.calls[1][1] as { fulfillment: { trackingInfo: { url: string } } }).fulfillment.trackingInfo.url)
      .toBe('https://www.dac.com.uy/envios/rastrear?guia=G%201');

    const c2 = makeClient((q) => (q === FULFILLMENT_ORDERS_QUERY ? orderData('UNFULFILLED', [FO_OPEN]) : created));
    await fulfillOrderWithTracking(c2.client, 123, 'LF-0001', undefined, false, { company: 'Reparto propio', sinUrl: true });
    const ti = (c2.request.mock.calls[1][1] as { fulfillment: { trackingInfo: Record<string, unknown> } }).fulfillment.trackingInfo;
    expect(ti).toEqual({ number: 'LF-0001', company: 'Reparto propio' });
    expect('url' in ti).toBe(false);
  });

  it('forceAll incluye in_progress/on_hold/scheduled/incomplete; sin forceAll sólo open', async () => {
    const c1 = makeClient((q) => (q === FULFILLMENT_ORDERS_QUERY ? orderData('ON_HOLD', [FO_ON_HOLD]) : created));
    await expect(fulfillOrderWithTracking(c1.client, 123, 'G')).rejects.toThrow(/No fulfillable orders for 123 \(found: \[on_hold\], accepted: \[open\]\)/);

    const c2 = makeClient((q) => (q === FULFILLMENT_ORDERS_QUERY ? orderData('ON_HOLD', [FO_ON_HOLD]) : created));
    await fulfillOrderWithTracking(c2.client, 123, 'G', undefined, true);
    expect((c2.request.mock.calls[1][1] as { fulfillment: { lineItemsByFulfillmentOrder: unknown[] } }).fulfillment.lineItemsByFulfillmentOrder)
      .toEqual([{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/7003' }]);
  });

  it('pre-check: FULFILLED / PARTIALLY_FULFILLED → ShopifyAlreadyFulfilledError sin mutación', async () => {
    const c1 = makeClient(() => orderData('FULFILLED', [FO_CLOSED]));
    await expect(fulfillOrderWithTracking(c1.client, 123, 'G')).rejects.toMatchObject({ isAlreadyFulfilled: true, status: 'fulfilled' });
    expect(c1.request).toHaveBeenCalledTimes(1);

    const c2 = makeClient(() => orderData('PARTIALLY_FULFILLED', [FO_OPEN]));
    await expect(fulfillOrderWithTracking(c2.client, 123, 'G')).rejects.toMatchObject({ isAlreadyFulfilled: true, status: 'partial' });
  });

  it('todos los FO CLOSED → ShopifyAlreadyFulfilledError', async () => {
    const c = makeClient(() => orderData('UNFULFILLED', [FO_CLOSED, { ...FO_CLOSED, id: 'gid://shopify/FulfillmentOrder/7009' }]));
    await expect(fulfillOrderWithTracking(c.client, 123, 'G')).rejects.toBeInstanceOf(ShopifyAlreadyFulfilledError);
  });

  it('ACCESS_DENIED (HTTP 200 + errors[]) → ShopifyMissingScopesError con la instrucción para el operador', async () => {
    const c = makeClient(() => {
      throw new ShopifyGraphqlError('Shopify GraphQL access denied', 'ACCESS_DENIED', [
        { message: 'Access denied for fulfillmentOrders field. Required access: `read_merchant_managed_fulfillment_orders` access scope.', extensions: { code: 'ACCESS_DENIED' } },
      ]);
    });
    const err = await fulfillOrderWithTracking(c.client, 123, 'G').catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyMissingScopesError);
    expect(err.message).toContain('read_assigned_fulfillment_orders');
    expect(err.message).toContain('Shopify Partners');
  });

  it('fulfillmentOrders null por permiso faltante en el campo (data presente) → ShopifyMissingScopesError', async () => {
    const c = makeClient(() => ({ order: { id: 'gid://shopify/Order/123', legacyResourceId: '123', displayFulfillmentStatus: 'UNFULFILLED', fulfillmentOrders: null } }));
    (c.client as { lastErrors: unknown[] }).lastErrors = [{ message: 'Access denied for fulfillmentOrders field.', path: ['order', 'fulfillmentOrders'], extensions: { code: 'ACCESS_DENIED' } }];
    const err = await fulfillOrderWithTracking(c.client, 123, 'G').catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyMissingScopesError);
    expect(err.message).toContain('Access denied for fulfillmentOrders field');
  });

  it('ACCESS_DENIED en la mutación también se traduce', async () => {
    const c = makeClient((q) => {
      if (q === FULFILLMENT_ORDERS_QUERY) return orderData('UNFULFILLED', [FO_OPEN]);
      throw new ShopifyGraphqlError('denied', 'ACCESS_DENIED');
    });
    await expect(fulfillOrderWithTracking(c.client, 123, 'G')).rejects.toBeInstanceOf(ShopifyMissingScopesError);
  });

  it('userErrors de fulfillmentCreate → Error con el detalle', async () => {
    const c = makeClient((q) => (q === FULFILLMENT_ORDERS_QUERY
      ? orderData('UNFULFILLED', [FO_OPEN])
      : { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: ['fulfillment', 'trackingInfo', 'url'], message: 'is not a valid URL' }] } }));
    await expect(fulfillOrderWithTracking(c.client, 123, 'G')).rejects.toThrow(/fulfillmentCreate failed: fulfillment\.trackingInfo\.url: is not a valid URL/);
  });

  it('sin fulfillment.id y sin userErrors → Error', async () => {
    const c = makeClient((q) => (q === FULFILLMENT_ORDERS_QUERY ? orderData('UNFULFILLED', [FO_OPEN]) : { fulfillmentCreate: { fulfillment: null, userErrors: [] } }));
    await expect(fulfillOrderWithTracking(c.client, 123, 'G')).rejects.toThrow(/fulfillment creation failed/);
  });

  it('guía inválida / PENDING- no llama a Shopify; pedido inexistente → Error claro', async () => {
    const c = makeClient(() => ({ order: null }));
    await expect(fulfillOrderWithTracking(c.client, 123, 'PENDING-1')).rejects.toThrow(/invalid guia/);
    expect(c.request).not.toHaveBeenCalled();
    await expect(fulfillOrderWithTracking(c.client, 123, 'G')).rejects.toThrow(/not found/);
  });
});
