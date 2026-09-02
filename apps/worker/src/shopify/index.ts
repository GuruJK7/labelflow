import type { AxiosInstance } from 'axios';
import logger from '../logger';
import { createShopifyClient as createRestClient } from './client';
import * as restOrders from './orders';
import * as restFulfillment from './fulfillment';
import type { ShopifyOrder } from './types';
import type { ShopifyGraphqlClient } from './graphql-client';
import {
  getShopifyApiPolicy,
  isRestForbiddenError,
  markRestForbidden,
  resolveShopifyApi,
  type ShopifyApiContext,
  type ShopifyApiMode,
} from './mode';

export { ShopifyAlreadyFulfilledError, ShopifyMissingScopesError } from './fulfillment';
export type { ShopifyOrder } from './types';
export type { ShopifyApiContext, ShopifyApiMode } from './mode';

/**
 * Fachada de Shopify del worker (D27).
 *
 * Los jobs, `self-delivery/process.ts` y `dac/finalize-recovered-guias.ts`
 * importan de acá y no saben si el tenant habla REST o GraphQL:
 *
 *   - REST (`orders.ts`, `fulfillment.ts`, `client.ts`): NO se tocó. Para un
 *     tenant en modo rest el camino es byte a byte el de siempre — mismos
 *     endpoints 2024-01, mismos parámetros, mismos logs.
 *   - GraphQL (`*-graphql.ts`): se carga con `import()` sólo cuando algún
 *     tenant lo necesita. Con SHOPIFY_API_MODE=rest el proceso nunca carga ni
 *     llama nada de GraphQL (hay test que lo afirma).
 *
 * `mode.ts` decide por tenant; si en modo auto REST contesta 403 (app sin
 * REST), se memoriza y la MISMA operación se reintenta por GraphQL.
 */

type GraphqlModules = {
  client: typeof import('./graphql-client');
  orders: typeof import('./orders-graphql');
  fulfillment: typeof import('./fulfillment-graphql');
};

let graphqlModules: Promise<GraphqlModules> | null = null;

async function loadGraphql(): Promise<GraphqlModules> {
  if (!graphqlModules) {
    graphqlModules = Promise.all([
      import('./graphql-client'),
      import('./orders-graphql'),
      import('./fulfillment-graphql'),
    ]).then(([client, orders, fulfillment]) => ({ client, orders, fulfillment }));
  }
  return graphqlModules;
}

/** Respuesta de `GET /orders/{id}.json` tal como la leen los jobs (`data.order?.note`). */
export interface ShopifyGetResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface ShopifyClient {
  readonly storeUrl: string;
  readonly ctx: ShopifyApiContext;
  /** Cliente REST de siempre (axios, 2024-01). Sólo lo usan las funciones de esta fachada. */
  readonly rest: AxiosInstance;
  /** Cliente GraphQL (2026-07), creado la primera vez que hace falta. */
  gql(): Promise<ShopifyGraphqlClient>;
  /**
   * Compatibilidad con los `shopifyClient.get('/orders/{id}.json')` directos
   * de los jobs. En GraphQL sólo se soporta ese path (nota/tags/estado).
   */
  get(path: string, config?: { params?: Record<string, unknown> }): Promise<ShopifyGetResponse>;
  /** Modo resuelto en este instante (puede cambiar tras un 403 REST en auto). */
  mode(): ShopifyApiMode;
}

const ORDER_JSON_PATH = /^\/orders\/(\d+)\.json$/;

async function dispatch<T>(
  client: ShopifyClient,
  op: string,
  viaRest: (rest: AxiosInstance) => Promise<T>,
  viaGraphql: (gql: ShopifyGraphqlClient, mods: GraphqlModules) => Promise<T>,
): Promise<T> {
  const runGraphql = async () => viaGraphql(await client.gql(), await loadGraphql());

  if (resolveShopifyApi(client.ctx) === 'graphql') return runGraphql();

  try {
    return await viaRest(client.rest);
  } catch (err) {
    if (getShopifyApiPolicy() !== 'auto') throw err;
    const forbidden = isRestForbiddenError(err);
    if (!forbidden) throw err;
    markRestForbidden(client.ctx, forbidden.body);
    logger.warn(
      { storeUrl: client.storeUrl, tenantId: client.ctx.tenantId ?? null, op },
      'Shopify REST 403: reintentando la operación por GraphQL',
    );
    return runGraphql();
  }
}

export function createShopifyClient(
  storeUrl: string,
  token: string,
  ctx: Omit<ShopifyApiContext, 'storeUrl'> = {},
): ShopifyClient {
  const fullCtx: ShopifyApiContext = { ...ctx, storeUrl };
  let gqlClient: ShopifyGraphqlClient | null = null;

  const client: ShopifyClient = {
    storeUrl,
    ctx: fullCtx,
    rest: createRestClient(storeUrl, token),
    async gql() {
      if (!gqlClient) {
        const mods = await loadGraphql();
        gqlClient = mods.client.createShopifyGraphqlClient(storeUrl, token);
      }
      return gqlClient;
    },
    get(path, config) {
      return dispatch(
        client,
        `GET ${path}`,
        (rest) => rest.get(path, config),
        (gql, mods) => {
          const m = ORDER_JSON_PATH.exec(path);
          if (!m) {
            throw new Error(`Shopify GraphQL mode: unsupported REST path ${path} (only /orders/{id}.json)`);
          }
          return mods.orders.getOrderRestShim(gql, Number(m[1]));
        },
      );
    },
    mode() {
      return resolveShopifyApi(fullCtx);
    },
  };
  return client;
}

export function getUnfulfilledOrders(
  client: ShopifyClient,
  sortDirection: 'oldest_first' | 'newest_first' = 'oldest_first',
): Promise<ShopifyOrder[]> {
  return dispatch(
    client,
    'getUnfulfilledOrders',
    (rest) => restOrders.getUnfulfilledOrders(rest, sortDirection),
    (gql, mods) => mods.orders.getUnfulfilledOrders(gql, sortDirection),
  );
}

export function getRecentOrders(client: ShopifyClient, limit: number = 5): Promise<ShopifyOrder[]> {
  return dispatch(
    client,
    'getRecentOrders',
    (rest) => restOrders.getRecentOrders(rest, limit),
    (gql, mods) => mods.orders.getRecentOrders(gql, limit),
  );
}

export function addOrderTag(client: ShopifyClient, orderId: number, tag: string): Promise<void> {
  return dispatch(
    client,
    'addOrderTag',
    (rest) => restOrders.addOrderTag(rest, orderId, tag),
    (gql, mods) => mods.orders.addOrderTag(gql, orderId, tag),
  );
}

export function addOrderNote(client: ShopifyClient, orderId: number, noteText: string): Promise<void> {
  return dispatch(
    client,
    'addOrderNote',
    (rest) => restOrders.addOrderNote(rest, orderId, noteText),
    (gql, mods) => mods.orders.addOrderNote(gql, orderId, noteText),
  );
}

export function markOrderProcessed(client: ShopifyClient, orderId: number, guia: string): Promise<void> {
  return dispatch(
    client,
    'markOrderProcessed',
    (rest) => restOrders.markOrderProcessed(rest, orderId, guia),
    (gql, mods) => mods.orders.markOrderProcessed(gql, orderId, guia),
  );
}

export function fulfillOrderWithTracking(
  client: ShopifyClient,
  orderId: number,
  guia: string,
  dacTrackingUrl?: string,
  forceAll = false,
  opts?: { company?: string; sinUrl?: boolean },
): Promise<void> {
  return dispatch(
    client,
    'fulfillOrderWithTracking',
    (rest) => restFulfillment.fulfillOrderWithTracking(rest, orderId, guia, dacTrackingUrl, forceAll, opts),
    (gql, mods) => mods.fulfillment.fulfillOrderWithTracking(gql, orderId, guia, dacTrackingUrl, forceAll, opts),
  );
}

/** Sólo para tests: olvida los módulos GraphQL cargados. */
export function _resetGraphqlModules(): void {
  graphqlModules = null;
}
