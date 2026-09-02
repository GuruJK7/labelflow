import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SHOPIFY_API_SECRET = 'secreto-de-test';
process.env.SHOPIFY_API_KEY = 'client-id-de-test';
process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';

const mocks = vi.hoisted(() => ({ getAuthenticatedTenant: vi.fn(), tenantFindFirst: vi.fn() }));
vi.mock('@/lib/api-utils', () => ({ getAuthenticatedTenant: mocks.getAuthenticatedTenant }));
vi.mock('@/lib/db', () => ({ db: { tenant: { findFirst: mocks.tenantFindFirst } } }));

import { GET } from '@/app/api/shopify/install/route';
import { STATE_COOKIE, TENANT_COOKIE, FLOW_COOKIE, FLOW_APPSTORE, NEXT_COOKIE } from '../shopify-oauth';
import { makeRequest, location, cookieDeleted, fakeTenantFindFirst } from './_shopify-route-utils';

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

  it('busca la tienda sin distinguir mayúsculas y excluyendo al propio tenant', async () => {
    await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com' }));
    expect(mocks.tenantFindFirst.mock.calls[0][0].where).toEqual({
      shopifyStoreUrl: { equals: 'acme.myshopify.com', mode: 'insensitive' },
      id: { not: 'tenant-1' },
    });
  });

  it('otro tenant la tiene guardada como "Acme.myshopify.com": already_linked (D18)', async () => {
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 'tenant-ajeno', shopifyStoreUrl: 'Acme.myshopify.com' }]),
    );
    const res = await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com' }));
    expect(location(res).pathname).toBe('/settings');
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
  });

  it('sin sesión: al login con next relativo', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValue(null);
    const res = await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com' }));
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('next')).toBe('/api/shopify/install?shop=acme.myshopify.com');
  });

  describe('next= (D33: volver al wizard)', () => {
    it('next=/onboarding → cookie NEXT con esa ruta', async () => {
      const res = await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com', next: '/onboarding' }));
      expect(location(res).pathname).toBe('/admin/oauth/authorize');
      expect(res.cookies.get(NEXT_COOKIE)?.value).toBe('/onboarding');
    });

    it('next absoluto o protocolo-relativo → NO se setea (y se borra una vieja)', async () => {
      for (const next of ['https://evil.com', '//evil.com', 'javascript:alert(1)']) {
        const res = await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com', next }));
        expect(location(res).pathname).toBe('/admin/oauth/authorize');
        expect(res.cookies.get(NEXT_COOKIE)?.value ?? '').toBe('');
      }
    });

    it('sin next → sin cookie NEXT (se borra) y los errores siguen yendo a /settings', async () => {
      const res = await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com' }));
      expect(cookieDeleted(res, NEXT_COOKIE)).toBe(true);
      const bad = await GET(makeRequest('/api/shopify/install', { shop: 'acme.evil.com' }));
      expect(location(bad).pathname).toBe('/settings');
      expect(location(bad).searchParams.get('shopify')).toBe('bad_shop');
    });

    it('con next válido, los errores de este paso vuelven al next (bad_shop, already_linked)', async () => {
      const bad = await GET(makeRequest('/api/shopify/install', { shop: 'acme.evil.com', next: '/onboarding' }));
      expect(location(bad).pathname).toBe('/onboarding');
      expect(location(bad).searchParams.get('shopify')).toBe('bad_shop');
      mocks.tenantFindFirst.mockResolvedValueOnce({ id: 'tenant-ajeno' });
      const linked = await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com', next: '/onboarding' }));
      expect(location(linked).pathname).toBe('/onboarding');
      expect(location(linked).searchParams.get('shopify')).toBe('already_linked');
    });

    it('sin sesión: el next viaja dentro del back al login', async () => {
      mocks.getAuthenticatedTenant.mockResolvedValue(null);
      const res = await GET(makeRequest('/api/shopify/install', { shop: 'acme.myshopify.com', next: '/onboarding' }));
      expect(location(res).searchParams.get('next')).toBe('/api/shopify/install?shop=acme.myshopify.com&next=%2Fonboarding');
    });
  });
});
