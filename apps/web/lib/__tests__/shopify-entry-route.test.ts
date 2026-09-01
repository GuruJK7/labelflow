import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SHOPIFY_API_SECRET = 'secreto-de-test';
process.env.SHOPIFY_API_KEY = 'client-id-de-test';
process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';

const mocks = vi.hoisted(() => ({ tenantFindFirst: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { tenant: { findFirst: mocks.tenantFindFirst } } }));

import { GET } from '@/app/api/shopify/entry/route';
import { STATE_COOKIE, TENANT_COOKIE, FLOW_COOKIE, FLOW_APPSTORE } from '../shopify-oauth';
import { signQuery, makeRequest, location, cookieDeleted } from './_shopify-route-utils';

const SECRET = process.env.SHOPIFY_API_SECRET as string;
const SHOP = 'acme.myshopify.com';

function signedQuery(extra: Record<string, string> = {}) {
  const q: Record<string, string> = {
    shop: SHOP,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extra,
  };
  q.hmac = signQuery(q, SECRET);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenantFindFirst.mockResolvedValue(null);
});

describe('/api/shopify/entry', () => {
  it('tienda nueva: arranca OAuth con STATE + FLOW=appstore y borra TENANT (H4)', async () => {
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery(), { [TENANT_COOKIE]: 'viejo' }));
    const loc = location(res);
    expect(loc.host).toBe(SHOP);
    expect(loc.pathname).toBe('/admin/oauth/authorize');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://autoenvia.com/api/shopify/callback');
    expect(res.cookies.get(STATE_COOKIE)?.value).toBe(loc.searchParams.get('state'));
    expect(res.cookies.get(FLOW_COOKIE)?.value).toBe(FLOW_APPSTORE);
    expect(cookieDeleted(res, TENANT_COOKIE)).toBe(true);
  });

  it('tienda ya vinculada con token vigente: NO reinicia OAuth, va a /login?shopify=open (H2)', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1' });
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery()));
    const loc = location(res);
    expect(loc.host).toBe('autoenvia.com');
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('open');
    expect(loc.searchParams.has('email')).toBe(false);
    expect(res.cookies.get(STATE_COOKIE)?.value ?? '').toBe('');
    expect(res.cookies.get(FLOW_COOKIE)?.value ?? '').toBe('');
    // El filtro pide token no nulo: una tienda desinstalada (token en null) sí reinstala.
    const where = mocks.tenantFindFirst.mock.calls[0][0].where;
    expect(where).toEqual({ shopifyStoreUrl: SHOP, shopifyToken: { not: null } });
  });

  it('HMAC inválido → /login?shopify=bad_hmac, sin tocar la base', async () => {
    const q = signedQuery();
    q.hmac = 'roto';
    const res = await GET(makeRequest('/api/shopify/entry', q));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('bad_hmac');
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
  });

  it('timestamp viejo → /login?shopify=stale', async () => {
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery({ timestamp: '1000' })));
    expect(location(res).searchParams.get('shopify')).toBe('stale');
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
  });

  it('sin shop: a la home, sin error', async () => {
    const res = await GET(makeRequest('/api/shopify/entry', {}));
    expect(location(res).pathname).toBe('/');
  });
});
