// D27: la fachada `shopify/index.ts` elige REST o GraphQL por tenant.
//   - modo rest / slug normal: llama a orders.ts/fulfillment.ts con el axios de
//     siempre y NUNCA carga los módulos GraphQL (ni siquiera el import).
//   - slug == tenantSlugForShop(storeUrl) (App Store): GraphQL directo sin tocar REST.
//   - auto + 403 REST que diga "app sin REST" en un tenant sin 2xx previo:
//     fallback a GraphQL en la misma operación y memo. Cualquier otro 403 sube.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  graphqlClientLoaded: false,
  ordersGraphqlLoaded: false,
  fulfillmentGraphqlLoaded: false,
}));

const restAxios = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
}));

const gqlRequest = vi.hoisted(() => vi.fn());

const gqlOrders = vi.hoisted(() => ({
  getUnfulfilledOrders: vi.fn(),
  getRecentOrders: vi.fn(),
  addOrderTag: vi.fn(),
  addOrderNote: vi.fn(),
  markOrderProcessed: vi.fn(),
  getOrderRestShim: vi.fn(),
}));
const gqlFulfillment = vi.hoisted(() => ({ fulfillOrderWithTracking: vi.fn() }));

vi.mock('../shopify/client', () => ({
  createShopifyClient: vi.fn(() => restAxios),
}));
vi.mock('../shopify/graphql-client', () => {
  state.graphqlClientLoaded = true;
  return {
    createShopifyGraphqlClient: vi.fn((storeUrl: string) => ({ storeUrl, apiVersion: '2026-07', request: gqlRequest, lastCost: null })),
  };
});
vi.mock('../shopify/orders-graphql', () => {
  state.ordersGraphqlLoaded = true;
  return gqlOrders;
});
vi.mock('../shopify/fulfillment-graphql', () => {
  state.fulfillmentGraphqlLoaded = true;
  return gqlFulfillment;
});

import {
  createShopifyClient,
  getUnfulfilledOrders,
  getRecentOrders,
  addOrderNote,
  markOrderProcessed,
  fulfillOrderWithTracking,
  ShopifyMissingScopesError,
  _resetGraphqlModules,
} from '../shopify';
import { _resetShopifyApiMemo, isRestForbiddenFor, isRestKnownWorking } from '../shopify/mode';

const TOKEN = 'shpat_x';

function axiosErr(status: number, body: unknown) {
  const err = new Error(`Request failed with status code ${status}`) as Error & { isAxiosError: true; response: unknown };
  err.isAxiosError = true;
  err.response = { status, data: body };
  return err;
}

const originalMode = process.env.SHOPIFY_API_MODE;
beforeEach(() => {
  vi.clearAllMocks();
  _resetShopifyApiMemo();
  _resetGraphqlModules();
  delete process.env.SHOPIFY_API_MODE;
});
afterEach(() => {
  if (originalMode === undefined) delete process.env.SHOPIFY_API_MODE;
  else process.env.SHOPIFY_API_MODE = originalMode;
});

describe('modo rest / tenant con token manual: camino REST intacto y sin GraphQL', () => {
  it('con SHOPIFY_API_MODE=rest no se carga ni se llama nada de GraphQL, ni para shop-*', async () => {
    process.env.SHOPIFY_API_MODE = 'rest';
    // Este test corre primero en el archivo: los factories de vi.mock de los
    // módulos GraphQL todavía no se ejecutaron porque la fachada los carga con import().
    expect(state.graphqlClientLoaded).toBe(false);
    expect(state.ordersGraphqlLoaded).toBe(false);
    expect(state.fulfillmentGraphqlLoaded).toBe(false);

    const client = createShopifyClient('aura.myshopify.com', TOKEN, { tenantId: 't1', slug: 'shop-aura' });
    expect(client.mode()).toBe('rest');

    restAxios.get.mockResolvedValue({ data: { orders: [] } });
    await getUnfulfilledOrders(client, 'newest_first');
    // Mismos endpoint y parámetros que orders.ts de siempre.
    expect(restAxios.get).toHaveBeenCalledWith('/orders.json', {
      params: {
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        status: 'open',
        limit: 250,
        order: 'created_at desc',
      },
    });

    restAxios.get.mockResolvedValue({ data: { order: { id: 5, note: 'hola' } } });
    const { data } = await client.get('/orders/5.json');
    expect(data.order.note).toBe('hola');

    expect(state.graphqlClientLoaded).toBe(false);
    expect(state.ordersGraphqlLoaded).toBe(false);
    expect(state.fulfillmentGraphqlLoaded).toBe(false);
    expect(gqlRequest).not.toHaveBeenCalled();
  });

  it('auto + slug normal → REST; un 403 de scopes ("required permission") NO conmuta y sale como ShopifyMissingScopesError', async () => {
    const client = createShopifyClient('aura.myshopify.com', TOKEN, { tenantId: 't2', slug: 'aura' });
    expect(client.mode()).toBe('rest');
    restAxios.get.mockImplementation(async (path: string) => {
      if (path.includes('/fulfillment_orders.json')) {
        throw axiosErr(403, { errors: 'The api_client does not have the required permission(s).' });
      }
      return { data: { order: { id: 123, fulfillment_status: null } } };
    });
    await expect(fulfillOrderWithTracking(client, 123, '8821111111111')).rejects.toBeInstanceOf(ShopifyMissingScopesError);
    expect(isRestForbiddenFor({ tenantId: 't2' })).toBe(false);
    expect(gqlFulfillment.fulfillOrderWithTracking).not.toHaveBeenCalled();
  });
});

describe('auto + slug del App Store: GraphQL directo', () => {
  it('slug manual que empieza con shop- (email shop@…) sigue en REST', async () => {
    const client = createShopifyClient('marca.myshopify.com', TOKEN, { tenantId: 't3b', slug: 'shop-marca-m1abcd' });
    expect(client.mode()).toBe('rest');
    restAxios.get.mockResolvedValue({ data: { orders: [] } });
    await getUnfulfilledOrders(client);
    expect(restAxios.get).toHaveBeenCalledTimes(1);
    expect(gqlOrders.getUnfulfilledOrders).not.toHaveBeenCalled();
  });

  it('no toca REST y usa el cliente GraphQL de la tienda', async () => {
    const client = createShopifyClient('autoenvia-qa.myshopify.com', TOKEN, { tenantId: 't3', slug: 'shop-autoenvia-qa' });
    expect(client.mode()).toBe('graphql');
    gqlOrders.getUnfulfilledOrders.mockResolvedValue([{ id: 1 }]);
    const orders = await getUnfulfilledOrders(client, 'oldest_first');
    expect(orders).toEqual([{ id: 1 }]);
    expect(gqlOrders.getUnfulfilledOrders).toHaveBeenCalledWith(
      expect.objectContaining({ storeUrl: 'autoenvia-qa.myshopify.com' }),
      'oldest_first',
    );
    expect(restAxios.get).not.toHaveBeenCalled();
  });

  it('client.get("/orders/{id}.json") pasa por el shim; otro path se rechaza claro', async () => {
    const client = createShopifyClient('autoenvia-qa.myshopify.com', TOKEN, { tenantId: 't3', slug: 'shop-autoenvia-qa' });
    gqlOrders.getOrderRestShim.mockResolvedValue({ data: { order: { id: 77, note: 'n' } } });
    const { data } = await client.get('/orders/77.json');
    expect(data.order.note).toBe('n');
    expect(gqlOrders.getOrderRestShim).toHaveBeenCalledWith(expect.anything(), 77);
    await expect(client.get('/orders/77/fulfillment_orders.json')).rejects.toThrow(/unsupported REST path/);
    expect(restAxios.get).not.toHaveBeenCalled();
  });

  it('fulfill / note / markOrderProcessed / getRecentOrders van al módulo GraphQL con la misma firma', async () => {
    const client = createShopifyClient('autoenvia-qa.myshopify.com', TOKEN, { tenantId: 't3', slug: 'shop-autoenvia-qa' });
    await fulfillOrderWithTracking(client, 9, 'G1', 'https://t', true, { company: 'Reparto propio', sinUrl: true });
    expect(gqlFulfillment.fulfillOrderWithTracking).toHaveBeenCalledWith(expect.anything(), 9, 'G1', 'https://t', true, { company: 'Reparto propio', sinUrl: true });
    await addOrderNote(client, 9, 'nota');
    expect(gqlOrders.addOrderNote).toHaveBeenCalledWith(expect.anything(), 9, 'nota');
    await markOrderProcessed(client, 9, 'G1');
    expect(gqlOrders.markOrderProcessed).toHaveBeenCalledWith(expect.anything(), 9, 'G1');
    await getRecentOrders(client, 7);
    expect(gqlOrders.getRecentOrders).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it('SHOPIFY_API_MODE=graphql fuerza GraphQL para un slug normal', async () => {
    process.env.SHOPIFY_API_MODE = 'graphql';
    const client = createShopifyClient('aura.myshopify.com', TOKEN, { tenantId: 't2', slug: 'aura' });
    expect(client.mode()).toBe('graphql');
    gqlOrders.getUnfulfilledOrders.mockResolvedValue([]);
    await getUnfulfilledOrders(client);
    expect(gqlOrders.getUnfulfilledOrders).toHaveBeenCalled();
    expect(restAxios.get).not.toHaveBeenCalled();
  });
});

describe('auto + 403 REST (app sin REST): fallback y memo', () => {
  it('reintenta la misma operación por GraphQL y deja al tenant en GraphQL', async () => {
    const client = createShopifyClient('nueva.myshopify.com', TOKEN, { tenantId: 't4', slug: 'nueva' });
    expect(client.mode()).toBe('rest');
    restAxios.get.mockRejectedValueOnce(axiosErr(403, { errors: 'This app is not approved to use the REST Admin API.' }));
    gqlOrders.getUnfulfilledOrders.mockResolvedValue([{ id: 42 }]);

    const orders = await getUnfulfilledOrders(client);
    expect(orders).toEqual([{ id: 42 }]);
    expect(restAxios.get).toHaveBeenCalledTimes(1);
    expect(gqlOrders.getUnfulfilledOrders).toHaveBeenCalledTimes(1);

    // Memo: la siguiente operación del mismo tenant va directo a GraphQL.
    expect(client.mode()).toBe('graphql');
    expect(isRestForbiddenFor({ tenantId: 't4' })).toBe(true);
    await addOrderNote(client, 42, 'x');
    expect(restAxios.get).toHaveBeenCalledTimes(1);
    expect(gqlOrders.addOrderNote).toHaveBeenCalledTimes(1);

    // Otro tenant no se contagia.
    const otro = createShopifyClient('aura.myshopify.com', TOKEN, { tenantId: 't5', slug: 'aura' });
    expect(otro.mode()).toBe('rest');
  });

  it('403 "merchant approval for read_orders scope" (token de custom app) NO conmuta: sube tal cual y el tenant sigue en REST', async () => {
    const client = createShopifyClient('aura.myshopify.com', TOKEN, { tenantId: 't6a', slug: 'aura' });
    restAxios.get.mockRejectedValueOnce(axiosErr(403, { errors: '[API] This action requires merchant approval for read_orders scope.' }));
    await expect(getUnfulfilledOrders(client)).rejects.toThrow(/403/);
    expect(gqlOrders.getUnfulfilledOrders).not.toHaveBeenCalled();
    expect(isRestForbiddenFor({ tenantId: 't6a' })).toBe(false);
    expect(client.mode()).toBe('rest');

    // Lo mismo para el GET directo de los jobs y un 403 "Forbidden" pelado.
    restAxios.get.mockRejectedValueOnce(axiosErr(403, 'Forbidden'));
    await expect(client.get('/orders/1.json')).rejects.toThrow(/403/);
    expect(gqlOrders.getOrderRestShim).not.toHaveBeenCalled();
    expect(client.mode()).toBe('rest');
  });

  it('un tenant al que REST ya le respondió 2xx nunca conmuta, ni con el cuerpo de "app sin REST"', async () => {
    const client = createShopifyClient('aura.myshopify.com', TOKEN, { tenantId: 't6b', slug: 'aura' });
    restAxios.get.mockResolvedValueOnce({ data: { orders: [] } });
    await getUnfulfilledOrders(client);
    expect(isRestKnownWorking({ tenantId: 't6b' })).toBe(true);

    restAxios.get.mockRejectedValueOnce(axiosErr(403, { errors: 'This app is not approved to use the REST Admin API.' }));
    await expect(client.get('/orders/1.json')).rejects.toThrow(/403/);
    expect(gqlOrders.getOrderRestShim).not.toHaveBeenCalled();
    expect(isRestForbiddenFor({ tenantId: 't6b' })).toBe(false);
    expect(client.mode()).toBe('rest');
  });

  it('401 / 500 REST NO conmutan: el error sube tal cual', async () => {
    const client = createShopifyClient('aura.myshopify.com', TOKEN, { tenantId: 't6', slug: 'aura' });
    restAxios.get.mockRejectedValueOnce(axiosErr(401, { errors: 'Invalid API key' }));
    await expect(getUnfulfilledOrders(client)).rejects.toThrow(/401/);
    expect(gqlOrders.getUnfulfilledOrders).not.toHaveBeenCalled();
    expect(client.mode()).toBe('rest');
  });

  it('con SHOPIFY_API_MODE=rest un 403 no conmuta nunca', async () => {
    process.env.SHOPIFY_API_MODE = 'rest';
    const client = createShopifyClient('aura.myshopify.com', TOKEN, { tenantId: 't7', slug: 'aura' });
    restAxios.get.mockRejectedValueOnce(axiosErr(403, 'Forbidden'));
    await expect(getUnfulfilledOrders(client)).rejects.toThrow(/403/);
    expect(gqlOrders.getUnfulfilledOrders).not.toHaveBeenCalled();
    expect(isRestForbiddenFor({ tenantId: 't7' })).toBe(false);
  });
});
