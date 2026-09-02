// D27: fetchShopInfo va por GraphQL (query { shop { name email myshopifyDomain } }).
// Antes pegaba a shop.json (REST) y la app pública recibía un rechazo →
// callback 'shop_info_failed' en el primer install real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '11'.repeat(32);
vi.mock('@/lib/db', () => ({ db: {} }));

import { fetchShopInfo, SHOP_INFO_QUERY } from '../shopify-provision';

const SHOP = 'autoenvia-qa.myshopify.com';
const TOKEN = 'shpat_no_loguear';

function installFetch(result: unknown | Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (result instanceof Error) throw result;
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchShopInfo (GraphQL)', () => {
  it('POST a graphql.json 2026-07 con la query del diseño y el token en el header', async () => {
    const fetchMock = installFetch({ data: { shop: { name: ' AutoEnvía QA ', email: ' Dueno@Tienda.COM ', myshopifyDomain: SHOP } } });
    const info = await fetchShopInfo(SHOP, TOKEN);
    expect(info).toEqual({ email: 'dueno@tienda.com', name: 'AutoEnvía QA', domain: SHOP });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${SHOP}/admin/api/2026-07/graphql.json`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(TOKEN);
    const body = JSON.parse(String(init.body));
    expect(body.query).toBe(SHOP_INFO_QUERY);
    for (const f of ['shop {', 'name', 'email', 'myshopifyDomain']) expect(body.query).toContain(f);
    expect(url).not.toContain('shop.json');
  });

  it('respeta apiVersion si se pasa', async () => {
    const fetchMock = installFetch({ data: { shop: { name: 'x', email: 'a@b.co' } } });
    await fetchShopInfo(SHOP, TOKEN, '2026-10');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/api/2026-10/graphql.json');
  });

  it('sin email válido → null (mejor no crear cuenta que crearla con basura)', async () => {
    installFetch({ data: { shop: { name: 'x', email: 'no-es-email' } } });
    expect(await fetchShopInfo(SHOP, TOKEN)).toBeNull();
    installFetch({ data: { shop: { name: 'x', email: null } } });
    expect(await fetchShopInfo(SHOP, TOKEN)).toBeNull();
  });

  it('nombre vacío cae al dominio', async () => {
    installFetch({ data: { shop: { name: '  ', email: 'a@b.co' } } });
    expect(await fetchShopInfo(SHOP, TOKEN)).toEqual({ email: 'a@b.co', name: SHOP, domain: SHOP });
  });

  it('errors[] con data null (ACCESS_DENIED) → null y el log no lleva el token', async () => {
    installFetch({ data: null, errors: [{ message: 'denied', extensions: { code: 'ACCESS_DENIED' } }] });
    expect(await fetchShopInfo(SHOP, TOKEN)).toBeNull();
    const logged = JSON.stringify((console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).toContain('ACCESS_DENIED');
    expect(logged).not.toContain(TOKEN);
  });

  it('HTTP 401 / 5xx → null; error de red → null', async () => {
    installFetch(new Response('{"errors":"Invalid API key"}', { status: 401 }));
    expect(await fetchShopInfo(SHOP, TOKEN)).toBeNull();
    installFetch(new Response('', { status: 503 }));
    expect(await fetchShopInfo(SHOP, TOKEN)).toBeNull();
    installFetch(new Error('ECONNRESET'));
    expect(await fetchShopInfo(SHOP, TOKEN)).toBeNull();
  });
});
