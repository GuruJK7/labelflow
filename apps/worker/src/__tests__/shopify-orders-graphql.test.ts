// D27: orders-graphql.ts devuelve la misma forma REST que orders.ts, pagina
// hasta 250, achica la página en MAX_COST_EXCEEDED, usa tagsAdd (atómico) y
// orderUpdate sólo con {id, note}.
import { describe, it, expect, vi } from 'vitest';
import {
  getUnfulfilledOrders,
  getRecentOrders,
  addOrderTag,
  addOrderNote,
  markOrderProcessed,
  getOrderRestShim,
  ORDERS_QUERY,
  ORDER_BY_ID_QUERY,
  TAGS_ADD_MUTATION,
  ORDER_NOTE_UPDATE_MUTATION,
  UNFULFILLED_QUERY_STRING,
} from '../shopify/orders-graphql';
import { ShopifyGraphqlError, type ShopifyGraphqlClient } from '../shopify/graphql-client';
import type { GqlOrderNode } from '../shopify/graphql-adapter';

type Handler = (query: string, variables: Record<string, unknown>, call: number) => unknown;

function makeClient(handler: Handler) {
  let call = 0;
  const request = vi.fn(async (q: string, v: Record<string, unknown> = {}) => handler(q, v, call++));
  const client = { storeUrl: 'qa.myshopify.com', apiVersion: '2026-07', request, lastCost: null, lastErrors: [] } as unknown as ShopifyGraphqlClient;
  return { client, request };
}

function node(id: number, over: Partial<GqlOrderNode> = {}): GqlOrderNode {
  return {
    id: `gid://shopify/Order/${id}`,
    legacyResourceId: String(id),
    name: `#${id}`,
    email: `c${id}@x.com`,
    tags: [],
    note: null,
    currencyCode: 'UYU',
    displayFulfillmentStatus: 'UNFULFILLED',
    displayFinancialStatus: 'PAID',
    totalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'UYU' } },
    shippingAddress: { firstName: 'A', city: 'Montevideo' },
    lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'li', title: 'T', quantity: 1, sku: 'S', product: { legacyResourceId: '1' } }] },
    ...over,
  };
}

function page(nodes: GqlOrderNode[], hasNextPage: boolean, endCursor: string | null = null) {
  return { orders: { pageInfo: { hasNextPage, endCursor }, nodes } };
}

describe('getUnfulfilledOrders', () => {
  it('manda el query string equivalente a REST, sortKey CREATED_AT y reverse según dirección', async () => {
    const { client, request } = makeClient(() => page([node(1)], false));
    const orders = await getUnfulfilledOrders(client, 'newest_first');
    expect(orders.map((o) => o.id)).toEqual([1]);
    expect(request).toHaveBeenCalledTimes(1);
    const [q, v] = request.mock.calls[0];
    expect(q).toBe(ORDERS_QUERY);
    expect(q).toContain('sortKey: CREATED_AT');
    expect(v).toEqual({ first: 25, after: null, query: UNFULFILLED_QUERY_STRING, reverse: true, lineItemsFirst: 50 });
    expect(UNFULFILLED_QUERY_STRING).toBe('financial_status:paid fulfillment_status:unfulfilled status:open');

    const c2 = makeClient(() => page([], false));
    await getUnfulfilledOrders(c2.client);
    expect(c2.request.mock.calls[0][1]).toMatchObject({ reverse: false });
  });

  it('pagina con endCursor hasta agotar y devuelve la forma REST', async () => {
    const { client, request } = makeClient((_q, v) => (v.after == null ? page([node(1), node(2)], true, 'CUR1') : page([node(3)], false)));
    const orders = await getUnfulfilledOrders(client);
    expect(orders.map((o) => o.id)).toEqual([1, 2, 3]);
    expect(request.mock.calls[1][1]).toMatchObject({ after: 'CUR1' });
    expect(orders[0]).toMatchObject({ name: '#1', email: 'c1@x.com', tags: '', total_price: '100.00', currency: 'UYU', customer: null });
    expect(orders[0].line_items[0]).toMatchObject({ title: 'T', quantity: 1, sku: 'S', product_id: 1 });
  });

  it('corta en 250 pedidos (el limit de REST) aunque haya más páginas', async () => {
    const { client, request } = makeClient((_q, v) => {
      const start = Number(v.after ?? 0);
      const n = Number(v.first);
      const nodes = Array.from({ length: n }, (_, i) => node(start + i + 1));
      return page(nodes, true, String(start + n));
    });
    const orders = await getUnfulfilledOrders(client);
    expect(orders).toHaveLength(250);
    expect(request).toHaveBeenCalledTimes(10);
  });

  it('MAX_COST_EXCEEDED: achica first y lineItemsFirst a la mitad y reintenta la misma página', async () => {
    const { client, request } = makeClient((_q, v, call) => {
      if (call === 0) throw new ShopifyGraphqlError('cost', 'MAX_COST_EXCEEDED');
      expect(v).toMatchObject({ first: 12, lineItemsFirst: 25, after: null });
      return page([node(1)], false);
    });
    const orders = await getUnfulfilledOrders(client);
    expect(orders).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('completa line_items paginados con la query por id (REST los trae todos de un saque)', async () => {
    const { client, request } = makeClient((q, v) => {
      if (q === ORDERS_QUERY) {
        return page([node(1, { lineItems: { pageInfo: { hasNextPage: true, endCursor: 'LI1' }, nodes: [{ id: 'a', title: 'A', quantity: 1 }] } })], false);
      }
      expect(q).toBe(ORDER_BY_ID_QUERY);
      expect(v).toEqual({ id: 'gid://shopify/Order/1', lineItemsFirst: 250, lineItemsAfter: 'LI1' });
      return { order: { id: 'gid://shopify/Order/1', legacyResourceId: '1', name: '#1', note: null, tags: [], displayFulfillmentStatus: 'UNFULFILLED', lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'b', title: 'B', quantity: 2 }] } } };
    });
    const orders = await getUnfulfilledOrders(client);
    expect(orders[0].line_items.map((li) => li.title)).toEqual(['A', 'B']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('otros errores del cliente suben tal cual', async () => {
    const { client } = makeClient(() => { throw new ShopifyGraphqlError('denied', 'ACCESS_DENIED'); });
    await expect(getUnfulfilledOrders(client)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});

describe('getRecentOrders (modo TEST)', () => {
  it('sin query, más nuevos primero, limitado a n', async () => {
    const { client, request } = makeClient(() => page([node(1), node(2), node(3)], true, 'X'));
    const orders = await getRecentOrders(client, 2);
    expect(orders.map((o) => o.id)).toEqual([1, 2]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({ first: 2, after: null, query: null, reverse: true, lineItemsFirst: 50 });
  });

  it('acota limit a [1, 250]', async () => {
    const { client, request } = makeClient(() => page([], false));
    await getRecentOrders(client, 999);
    expect(request.mock.calls[0][1]).toMatchObject({ first: 25 }); // primera página; el tope 250 lo aplica el bucle
    await getRecentOrders(client, 0);
    expect(request.mock.calls[1][1]).toMatchObject({ first: 1 });
  });
});

describe('getOrderRestShim', () => {
  it('devuelve { data: { order: { id, note, tags CSV, fulfillment_status } } } con lineItemsFirst 1', async () => {
    const { client, request } = makeClient(() => ({
      order: { id: 'gid://shopify/Order/9', legacyResourceId: '9', name: '#9', note: 'LabelFlow-GUIA: 1', tags: ['a', 'b'], displayFulfillmentStatus: 'FULFILLED', lineItems: { pageInfo: { hasNextPage: false }, nodes: [] } },
    }));
    const res = await getOrderRestShim(client, 9);
    expect(res).toEqual({ data: { order: { id: 9, name: '#9', note: 'LabelFlow-GUIA: 1', tags: 'a, b', fulfillment_status: 'fulfilled' } } });
    expect(request.mock.calls[0]).toEqual([ORDER_BY_ID_QUERY, { id: 'gid://shopify/Order/9', lineItemsFirst: 1, lineItemsAfter: null }]);
  });

  it('pedido inexistente → order null (los jobs hacen data.order?.note)', async () => {
    const { client } = makeClient(() => ({ order: null }));
    const res = await getOrderRestShim(client, 9);
    expect(res.data.order).toBeNull();
    expect(res.data.order?.note ?? '').toBe('');
  });
});

describe('addOrderTag / addOrderNote / markOrderProcessed', () => {
  it('addOrderTag usa tagsAdd con el GID, sin lectura previa', async () => {
    const { client, request } = makeClient(() => ({ tagsAdd: { node: { id: 'gid://shopify/Order/9' }, userErrors: [] } }));
    await addOrderTag(client, 9, 'RASTREO ENVIADO');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual([TAGS_ADD_MUTATION, { id: 'gid://shopify/Order/9', tags: ['RASTREO ENVIADO'] }]);
  });

  it('userErrors de tagsAdd → throw', async () => {
    const { client } = makeClient(() => ({ tagsAdd: { node: null, userErrors: [{ field: ['id'], message: 'Order does not exist' }] } }));
    await expect(addOrderTag(client, 9, 'x')).rejects.toThrow(/tagsAdd failed: id: Order does not exist/);
  });

  it('addOrderNote lee la nota actual y manda orderUpdate SÓLO con id y note concatenada', async () => {
    const { client, request } = makeClient((q) => (q === ORDER_BY_ID_QUERY
      ? { order: { id: 'gid://shopify/Order/9', legacyResourceId: '9', name: '#9', note: 'vieja', tags: [], displayFulfillmentStatus: null, lineItems: { pageInfo: { hasNextPage: false }, nodes: [] } } }
      : { orderUpdate: { order: { id: 'gid://shopify/Order/9', note: 'vieja\nnueva' }, userErrors: [] } }));
    await addOrderNote(client, 9, 'nueva');
    expect(request.mock.calls[1]).toEqual([ORDER_NOTE_UPDATE_MUTATION, { input: { id: 'gid://shopify/Order/9', note: 'vieja\nnueva' } }]);
    expect(Object.keys((request.mock.calls[1][1] as { input: object }).input)).toEqual(['id', 'note']);
  });

  it('addOrderNote con nota vacía manda sólo la nueva', async () => {
    const { client, request } = makeClient((q) => (q === ORDER_BY_ID_QUERY
      ? { order: { id: 'gid://shopify/Order/9', legacyResourceId: '9', name: '#9', note: null, tags: [], displayFulfillmentStatus: null, lineItems: { pageInfo: { hasNextPage: false }, nodes: [] } } }
      : { orderUpdate: { order: null, userErrors: [] } }));
    await addOrderNote(client, 9, 'nueva');
    expect(request.mock.calls[1][1]).toEqual({ input: { id: 'gid://shopify/Order/9', note: 'nueva' } });
  });

  it('markOrderProcessed = tag RASTREO ENVIADO + nota LabelFlow-GUIA', async () => {
    const { client, request } = makeClient((q) => {
      if (q === TAGS_ADD_MUTATION) return { tagsAdd: { node: { id: 'x' }, userErrors: [] } };
      if (q === ORDER_BY_ID_QUERY) return { order: { id: 'gid://shopify/Order/9', legacyResourceId: '9', name: '#9', note: '', tags: [], displayFulfillmentStatus: null, lineItems: { pageInfo: { hasNextPage: false }, nodes: [] } } };
      return { orderUpdate: { order: null, userErrors: [] } };
    });
    await markOrderProcessed(client, 9, '8821238402641');
    expect(request.mock.calls[0][1]).toEqual({ id: 'gid://shopify/Order/9', tags: ['RASTREO ENVIADO'] });
    const note = (request.mock.calls[2][1] as { input: { note: string } }).input.note;
    expect(note).toMatch(/^LabelFlow-GUIA: 8821238402641 \| \d{4}-\d{2}-\d{2}T/);
  });
});
