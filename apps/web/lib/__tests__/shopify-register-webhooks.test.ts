// D27: el registro de webhooks post-OAuth va por GraphQL (la app pública no
// puede usar REST). Idempotencia por consulta previa, no por texto de error.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerShopifyWebhooks,
  webhookTopicEnum,
  webhookAddressFor,
  WEBHOOK_SUBSCRIPTIONS_QUERY,
  WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
} from '../shopify-register-webhooks';

const SHOP = 'autoenvia-qa.myshopify.com';
const TOKEN = 'shpat_no_loguear';
const ORIGIN = 'https://autoenvia.com';

type Call = { url: string; body: { query: string; variables: Record<string, unknown> }; headers: Record<string, string> };

function installFetch(handler: (call: Call, n: number) => unknown) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const result = handler(call, calls.length - 1);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const emptySubs = { data: { webhookSubscriptions: { nodes: [] } } };
const created = (topic: string, uri: string) => ({
  data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1', topic, uri, format: 'JSON' }, userErrors: [] } },
});

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('helpers', () => {
  it('mapea topics REST a enums de WebhookSubscriptionTopic', () => {
    expect(webhookTopicEnum('orders/paid')).toBe('ORDERS_PAID');
    expect(webhookTopicEnum('app/uninstalled')).toBe('APP_UNINSTALLED');
  });

  it('las direcciones siguen siendo las de siempre', () => {
    expect(webhookAddressFor('orders/paid', ORIGIN)).toBe('https://autoenvia.com/api/webhooks/shopify');
    expect(webhookAddressFor('app/uninstalled', ORIGIN)).toBe('https://autoenvia.com/api/shopify/uninstalled');
  });
});

describe('registerShopifyWebhooks', () => {
  it('consulta webhookSubscriptions con los topics y crea los que faltan con uri + format JSON', async () => {
    const { calls } = installFetch((call) => {
      if (call.body.query === WEBHOOK_SUBSCRIPTIONS_QUERY) return emptySubs;
      const v = call.body.variables as { topic: string; webhookSubscription: { uri: string } };
      return created(v.topic, v.webhookSubscription.uri);
    });

    const r = await registerShopifyWebhooks(SHOP, TOKEN, ORIGIN);
    // Tres topics desde que el cobro va por la Billing API de Shopify: sin
    // `app_purchases_one_time/update` el comerciante paga y no se le acredita.
    expect(r).toEqual({
      registered: ['orders/paid', 'app/uninstalled', 'app_purchases_one_time/update'],
      alreadyPresent: [],
      failed: [],
    });

    expect(calls).toHaveLength(4); // 1 consulta + 3 creaciones
    for (const c of calls) {
      expect(c.url).toBe(`https://${SHOP}/admin/api/2026-07/graphql.json`);
      expect(c.headers['X-Shopify-Access-Token']).toBe(TOKEN);
    }
    expect(calls[0].body.query).toContain('webhookSubscriptions(first: 50, topics: $topics)');
    expect(calls[0].body.variables).toEqual({
      topics: ['ORDERS_PAID', 'APP_UNINSTALLED', 'APP_PURCHASES_ONE_TIME_UPDATE'],
    });

    expect(calls[1].body.query).toBe(WEBHOOK_SUBSCRIPTION_CREATE_MUTATION);
    expect(calls[1].body.query).toContain('webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription)');
    expect(calls[1].body.variables).toEqual({
      topic: 'ORDERS_PAID',
      webhookSubscription: { uri: 'https://autoenvia.com/api/webhooks/shopify', format: 'JSON' },
    });
    expect(calls[2].body.variables).toEqual({
      topic: 'APP_UNINSTALLED',
      webhookSubscription: { uri: 'https://autoenvia.com/api/shopify/uninstalled', format: 'JSON' },
    });
  });

  it('alreadyPresent cuando la suscripción (topic + uri) ya existe: no llama a la mutación', async () => {
    const { calls } = installFetch((call) => {
      if (call.body.query === WEBHOOK_SUBSCRIPTIONS_QUERY) {
        return { data: { webhookSubscriptions: { nodes: [
          { id: 'g1', topic: 'ORDERS_PAID', uri: 'https://autoenvia.com/api/webhooks/shopify/', format: 'JSON' },
        ] } } };
      }
      const v = call.body.variables as { topic: string; webhookSubscription: { uri: string } };
      return created(v.topic, v.webhookSubscription.uri);
    });
    const r = await registerShopifyWebhooks(SHOP, TOKEN, ORIGIN);
    expect(r).toEqual({
      registered: ['app/uninstalled', 'app_purchases_one_time/update'],
      alreadyPresent: ['orders/paid'],
      failed: [],
    });
    expect(calls).toHaveLength(3); // 1 consulta + los 2 que faltaban
    expect(calls[1].body.variables).toMatchObject({ topic: 'APP_UNINSTALLED' });
    expect(calls[2].body.variables).toMatchObject({
      topic: 'APP_PURCHASES_ONE_TIME_UPDATE',
      webhookSubscription: { uri: 'https://autoenvia.com/api/webhooks/shopify/app-purchases' },
    });
  });

  it('misma topic pero otra uri (otro entorno) NO cuenta como presente', async () => {
    installFetch((call) => {
      if (call.body.query === WEBHOOK_SUBSCRIPTIONS_QUERY) {
        return { data: { webhookSubscriptions: { nodes: [
          { id: 'g1', topic: 'ORDERS_PAID', uri: 'https://staging.autoenvia.com/api/webhooks/shopify', format: 'JSON' },
        ] } } };
      }
      const v = call.body.variables as { topic: string; webhookSubscription: { uri: string } };
      return created(v.topic, v.webhookSubscription.uri);
    });
    const r = await registerShopifyWebhooks(SHOP, TOKEN, ORIGIN, ['orders/paid']);
    expect(r.registered).toEqual(['orders/paid']);
  });

  it('userErrors → failed con status 200 y el JSON de los errores', async () => {
    installFetch((call) => {
      if (call.body.query === WEBHOOK_SUBSCRIPTIONS_QUERY) return emptySubs;
      return { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['webhookSubscription', 'uri'], message: 'Invalid URI' }] } } };
    });
    const r = await registerShopifyWebhooks(SHOP, TOKEN, ORIGIN, ['orders/paid']);
    expect(r.registered).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ topic: 'orders/paid', status: 200 });
    expect(r.failed[0].body).toContain('Invalid URI');
    expect(r.failed[0].body).not.toContain(TOKEN);
  });

  it('userError de duplicado (carrera con otro callback) cuenta como alreadyPresent', async () => {
    installFetch((call) => {
      if (call.body.query === WEBHOOK_SUBSCRIPTIONS_QUERY) return emptySubs;
      return { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['address'], message: 'Address for this topic has already been taken' }] } } };
    });
    const r = await registerShopifyWebhooks(SHOP, TOKEN, ORIGIN, ['orders/paid']);
    expect(r).toEqual({ registered: [], alreadyPresent: ['orders/paid'], failed: [] });
  });

  it('HTTP no-200 en la mutación → failed con ese status; errores top-level (ACCESS_DENIED) → failed', async () => {
    installFetch((call, n) => {
      if (call.body.query === WEBHOOK_SUBSCRIPTIONS_QUERY) return emptySubs;
      if (n === 1) return new Response('{"errors":"Invalid API key"}', { status: 401 });
      return { data: null, errors: [{ message: 'Access denied for webhookSubscriptionCreate', extensions: { code: 'ACCESS_DENIED' } }] };
    });
    const r = await registerShopifyWebhooks(SHOP, TOKEN, ORIGIN);
    expect(r.registered).toEqual([]);
    expect(r.failed.map((f) => [f.topic, f.status])).toEqual([
      ['orders/paid', 401],
      ['app/uninstalled', 200],
      ['app_purchases_one_time/update', 200],
    ]);
    expect(r.failed[1].body).toContain('ACCESS_DENIED');
    // El del cobro también tiene que reportarse: un fallo silencioso ahí
    // significa comerciantes que pagan y no ven el saldo.
    expect(r.failed[2].body).toContain('ACCESS_DENIED');
  });

  it('si la consulta previa falla, igual intenta crear (no pierde suscripciones en silencio)', async () => {
    const { calls } = installFetch((call) => {
      if (call.body.query === WEBHOOK_SUBSCRIPTIONS_QUERY) throw new Error('timeout');
      const v = call.body.variables as { topic: string; webhookSubscription: { uri: string } };
      return created(v.topic, v.webhookSubscription.uri);
    });
    const r = await registerShopifyWebhooks(SHOP, TOKEN, ORIGIN, ['orders/paid']);
    expect(r.registered).toEqual(['orders/paid']);
    expect(calls).toHaveLength(2);
  });

  it('error de red en la mutación → failed status 0 con el mensaje', async () => {
    installFetch((call) => {
      if (call.body.query === WEBHOOK_SUBSCRIPTIONS_QUERY) return emptySubs;
      throw new Error('ECONNRESET');
    });
    const r = await registerShopifyWebhooks(SHOP, TOKEN, ORIGIN, ['orders/paid']);
    expect(r.failed).toEqual([{ topic: 'orders/paid', status: 0, body: 'ECONNRESET' }]);
  });
});
