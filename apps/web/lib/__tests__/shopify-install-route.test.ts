import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SHOPIFY_API_SECRET = 'secreto-de-test';
process.env.SHOPIFY_API_KEY = 'client-id-de-test';
process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';

const mocks = vi.hoisted(() => ({ getAuthenticatedTenant: vi.fn(), tenantFindFirst: vi.fn() }));
vi.mock('@/lib/api-utils', () => ({ getAuthenticatedTenant: mocks.getAuthenticatedTenant }));
vi.mock('@/lib/db', () => ({ db: { tenant: { findFirst: mocks.tenantFindFirst } } }));

import { GET } from '@/app/api/shopify/install/route';
import { STATE_COOKIE, TENANT_COOKIE, FLOW_COOKIE, FLOW_APPSTORE } from '../shopify-oauth';
import { makeRequest, location, cookieDeleted } from './_shopify-route-utils';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedTenant.mockResolvedValue({ userId: 'u1', tenantId: 'tenant-1', isActive: true, subscriptionStatus: 'ACTIVE' });
  mocks.tenantFindFirst.mockResolvedValue(null);
});

describe('/api/shopify/install', () => {
  it('arranca OAuth con STATE + TENANT y BORRA una FLOW=appstore abandonada (H4)', async () => {
    const res = await GET(
      makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com' }, { [FLOW_COOKIE]: FLOW_APPSTORE }),
    );
    const loc = location(res);
    expect(loc.pathname).toBe('/admin/oauth/authorize');
    expect(res.cookies.get(STATE_COOKIE)?.value).toBe(loc.searchParams.get('state'));
    expect(res.cookies.get(TENANT_COOKIE)?.value).toBe('tenant-1');
    expect(cookieDeleted(res, FLOW_COOKIE)).toBe(true);
  });

  it('sin sesión: al login con next relativo', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValue(null);
    const res = await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com' }));
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('next')).toBe('/api/shopify/install?shop=acme.myshopify.com');
  });
});
