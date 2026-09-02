// D27: el cliente GraphQL tiene que leer errors[] aunque el HTTP sea 200,
// esperar en THROTTLED, reintentar 5xx/red, no abortar por errores parciales
// (datos protegidos) y no filtrar el token en ningún mensaje.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createShopifyGraphqlClient,
  assertNoUserErrors,
  throttleWaitSeconds,
  ShopifyGraphqlError,
  isGraphqlAccessDenied,
  isGraphqlMaxCostExceeded,
  _resetGraphqlPartialWarnings,
} from '../shopify/graphql-client';

const TOKEN = 'shpat_SECRETO_NO_LOGUEAR';
const SHOP = 'autoenvia-qa.myshopify.com';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('fetch sin respuesta programada');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = { sleep: async () => {} };

beforeEach(() => _resetGraphqlPartialWarnings());

describe('createShopifyGraphqlClient', () => {
  it('POST a /admin/api/2026-07/graphql.json con el token en el header y query+variables en el body', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ data: { shop: { name: 'QA' } } })]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    const data = await c.request<{ shop: { name: string } }>('query { shop { name } }', { a: 1 });
    expect(data.shop.name).toBe('QA');
    expect(calls[0].url).toBe(`https://${SHOP}/admin/api/2026-07/graphql.json`);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(TOKEN);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ query: 'query { shop { name } }', variables: { a: 1 } });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('THROTTLED: espera según throttleStatus y reintenta; devuelve el resultado del reintento', async () => {
    const throttled = {
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
      extensions: { cost: { requestedQueryCost: 500, actualQueryCost: 0, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 } } },
    };
    const { fetchImpl } = makeFetch([jsonResponse(throttled), jsonResponse({ data: { ok: true } })]);
    const sleep = vi.fn(async (_ms: number) => {});
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, sleep });
    await expect(c.request('q')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(8000); // ceil((500-100)/50) = 8 s
  });

  it('THROTTLED persistente: corta a los 3 reintentos con code THROTTLED', async () => {
    const throttled = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] };
    const { fetchImpl, calls } = makeFetch([jsonResponse(throttled), jsonResponse(throttled), jsonResponse(throttled), jsonResponse(throttled)]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    const err = (await c.request('q').catch((e) => e)) as ShopifyGraphqlError;
    expect(err).toBeInstanceOf(ShopifyGraphqlError);
    expect(err.code).toBe('THROTTLED');
    expect(calls).toHaveLength(4);
  });

  it('5xx y error de red se reintentan con backoff corto', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse({}, 502),
      new Error('ECONNRESET'),
      jsonResponse({ data: { ok: 1 } }),
    ]);
    const sleep = vi.fn(async (_ms: number) => {});
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, sleep });
    await expect(c.request('q')).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls.map((a) => a[0])).toEqual([500, 1000]);
  });

  it('401/403/402/423 no se reintentan y el mensaje no lleva el token', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ errors: 'Invalid API key or access token' }, 401)]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    const err = (await c.request('q').catch((e) => e)) as ShopifyGraphqlError;
    expect(err).toBeInstanceOf(ShopifyGraphqlError);
    expect(err.code).toBe('HTTP_401');
    expect(err.httpStatus).toBe(401);
    expect(err.message).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
  });

  it('ACCESS_DENIED con data null → ShopifyGraphqlError code ACCESS_DENIED', async () => {
    const { fetchImpl } = makeFetch([jsonResponse({
      data: null,
      errors: [{ message: 'Access denied for fulfillmentOrders field. Required access: `read_merchant_managed_fulfillment_orders` access scope.', extensions: { code: 'ACCESS_DENIED' } }],
    })]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    const err = (await c.request('q').catch((e) => e)) as ShopifyGraphqlError;
    expect(isGraphqlAccessDenied(err)).toBe(true);
    expect(err.message).toContain('access denied');
    expect(err.message).not.toContain(TOKEN);
  });

  it('MAX_COST_EXCEEDED → error tipado para que el adaptador achique la página', async () => {
    const { fetchImpl } = makeFetch([jsonResponse({
      errors: [{ message: 'Query cost is 1200, which exceeds the single query max cost limit (1000).', extensions: { code: 'MAX_COST_EXCEEDED', cost: 1200, maxCost: 1000 } }],
    })]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    const err = (await c.request('q').catch((e) => e)) as ShopifyGraphqlError;
    expect(isGraphqlMaxCostExceeded(err)).toBe(true);
  });

  it('errores parciales por path con data presente NO abortan (datos protegidos en null)', async () => {
    const { fetchImpl } = makeFetch([jsonResponse({
      data: { orders: { nodes: [{ id: 'gid://shopify/Order/1', email: null }] } },
      errors: [{ message: 'This app is not approved to access the Order.email field.', path: ['orders', 'nodes', 0, 'email'], extensions: { code: 'ACCESS_DENIED_PROTECTED' } }],
    })]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    const data = await c.request<{ orders: { nodes: Array<{ email: string | null }> } }>('q');
    expect(data.orders.nodes[0].email).toBeNull();
  });

  it('errores por path con code ACCESS_DENIED y data presente tampoco abortan; quedan en lastErrors', async () => {
    const { fetchImpl } = makeFetch([jsonResponse({
      data: { order: { id: 'gid://shopify/Order/1', fulfillmentOrders: null } },
      errors: [{ message: 'Access denied for fulfillmentOrders field.', path: ['order', 'fulfillmentOrders'], extensions: { code: 'ACCESS_DENIED' } }],
    })]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    const data = await c.request<{ order: { fulfillmentOrders: null } }>('q');
    expect(data.order.fulfillmentOrders).toBeNull();
    expect(c.lastErrors.map((e) => e.extensions?.code)).toEqual(['ACCESS_DENIED']);
  });

  it('sin errors y sin data → NO_DATA', async () => {
    const { fetchImpl } = makeFetch([jsonResponse({ data: null })]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    await expect(c.request('q')).rejects.toMatchObject({ code: 'NO_DATA' });
  });

  it('guarda el último extensions.cost en lastCost', async () => {
    const { fetchImpl } = makeFetch([jsonResponse({
      data: { ok: 1 },
      extensions: { cost: { requestedQueryCost: 120, actualQueryCost: 80, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 900, restoreRate: 50 } } },
    })]);
    const c = createShopifyGraphqlClient(SHOP, TOKEN, { fetchImpl, ...noSleep });
    await c.request('q');
    expect(c.lastCost?.requestedQueryCost).toBe(120);
  });
});

describe('helpers', () => {
  it('assertNoUserErrors lanza con campo y mensaje', () => {
    expect(() => assertNoUserErrors('tagsAdd', [])).not.toThrow();
    expect(() => assertNoUserErrors('tagsAdd', null)).not.toThrow();
    expect(() => assertNoUserErrors('fulfillmentCreate', [{ field: ['fulfillment', 'trackingInfo', 'url'], message: 'is invalid' }]))
      .toThrow(/Shopify fulfillmentCreate failed: fulfillment\.trackingInfo\.url: is invalid/);
  });

  it('throttleWaitSeconds: mínimo 1, y ceil((requested-available)/restoreRate)', () => {
    expect(throttleWaitSeconds(undefined)).toBe(1);
    expect(throttleWaitSeconds({ requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 900, restoreRate: 50 } })).toBe(1);
    expect(throttleWaitSeconds({ requestedQueryCost: 1000, throttleStatus: { currentlyAvailable: 0, restoreRate: 100 } })).toBe(10);
  });
});
