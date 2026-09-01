import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.ENCRYPTION_KEY = '44'.repeat(32);
process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';

const mocks = vi.hoisted(() => {
  const tx = {
    tenant: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  };
  return {
    tx,
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    getAuthenticatedUser: vi.fn(),
    fetchShopInfo: vi.fn(),
    registerShopifyWebhooks: vi.fn(),
  };
});
vi.mock('@/lib/api-utils', () => ({ getAuthenticatedUser: mocks.getAuthenticatedUser }));
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction, tenant: mocks.tx.tenant } }));
vi.mock('@/lib/shopify-provision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shopify-provision')>()),
  fetchShopInfo: mocks.fetchShopInfo,
}));
vi.mock('@/lib/shopify-register-webhooks', () => ({
  registerShopifyWebhooks: mocks.registerShopifyWebhooks,
}));

import { GET } from '@/app/api/shopify/claim/route';
import { PENDING_INSTALL_COOKIE } from '../shopify-oauth';
import { sealPendingInstall } from '../shopify-pending-install';
import { decrypt } from '../encryption';
import { makeRequest, location } from './_shopify-route-utils';

const SHOP = 'acme.myshopify.com';

function pendingCookie(nowMs = Date.now()) {
  return { [PENDING_INSTALL_COOKIE]: sealPendingInstall({ shop: SHOP, token: 'shpat_pend' }, nowMs) };
}

/** La cookie pendiente tiene que salir borrada, con el mismo path con que se creó. */
function pendingDeleted(res: Awaited<ReturnType<typeof GET>>): boolean {
  const c = res.cookies.get(PENDING_INSTALL_COOKIE);
  return !!c && c.value === '' && c.path === '/api/shopify';
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u-sesion' });
  mocks.fetchShopInfo.mockResolvedValue({ email: 'x@acme.com', name: 'Acme', domain: SHOP });
  mocks.registerShopifyWebhooks.mockResolvedValue({ registered: [], alreadyPresent: [], failed: [] });
  mocks.tx.tenant.findFirst.mockResolvedValue(null);
  mocks.tx.tenant.findUnique.mockResolvedValue(null);
  mocks.tx.tenant.create.mockResolvedValue({ id: 't-nuevo' });
});

describe('/api/shopify/claim', () => {
  it('sin sesión: vuelve al login con next, y conserva la cookie para poder volver', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    const res = await GET(makeRequest('/api/shopify/claim', {}, pendingCookie()));
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('claim');
    expect(loc.searchParams.get('next')).toBe('/api/shopify/claim');
    expect(res.cookies.get(PENDING_INSTALL_COOKIE)).toBeUndefined();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('sin cookie: claim_expired', async () => {
    const res = await GET(makeRequest('/api/shopify/claim', {}));
    expect(location(res).pathname).toBe('/settings');
    expect(location(res).searchParams.get('shopify')).toBe('claim_expired');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('cookie que no descifra: claim_invalid y se borra', async () => {
    const res = await GET(makeRequest('/api/shopify/claim', {}, { [PENDING_INSTALL_COOKIE]: 'basura' }));
    expect(location(res).searchParams.get('shopify')).toBe('claim_invalid');
    expect(pendingDeleted(res)).toBe(true);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('cookie con más de 600 s: claim_invalid y se borra', async () => {
    const res = await GET(makeRequest('/api/shopify/claim', {}, pendingCookie(Date.now() - 601_000)));
    expect(location(res).searchParams.get('shopify')).toBe('claim_invalid');
    expect(pendingDeleted(res)).toBe(true);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('la tienda ya tiene dueño (chequeo en la transacción): already_linked, no crea nada', async () => {
    mocks.tx.tenant.findFirst.mockResolvedValue({ id: 't-ajeno' });
    const res = await GET(makeRequest('/api/shopify/claim', {}, pendingCookie()));
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(mocks.tx.tenant.create).not.toHaveBeenCalled();
    expect(mocks.registerShopifyWebhooks).not.toHaveBeenCalled();
    expect(pendingDeleted(res)).toBe(true);
  });

  it('carrera perdida (P2002): already_linked', async () => {
    mocks.tx.tenant.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const res = await GET(makeRequest('/api/shopify/claim', {}, pendingCookie()));
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(pendingDeleted(res)).toBe(true);
  });

  it('camino feliz: crea el tenant bajo el user de la SESIÓN, registra webhooks, borra la cookie', async () => {
    const res = await GET(makeRequest('/api/shopify/claim', {}, pendingCookie()));
    const loc = location(res);
    expect(loc.pathname).toBe('/settings');
    expect(loc.searchParams.get('shopify')).toBe('connected');

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const data = mocks.tx.tenant.create.mock.calls[0][0].data;
    expect(data.userId).toBe('u-sesion');
    expect(data.slug).toBe('shop-acme');
    expect(data.name).toBe('Acme');
    expect(data.shopifyStoreUrl).toBe(SHOP);
    expect(decrypt(data.shopifyToken)).toBe('shpat_pend');
    expect(data.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(data.referralCode).toMatch(/^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/);
    expect(data.tosAcceptedAt).toBeUndefined();

    expect(mocks.registerShopifyWebhooks).toHaveBeenCalledWith(SHOP, 'shpat_pend', 'https://autoenvia.com');
    expect(pendingDeleted(res)).toBe(true);
  });

  it('si shop.json no contesta, igual reclama con el handle como nombre', async () => {
    mocks.fetchShopInfo.mockResolvedValue(null);
    const res = await GET(makeRequest('/api/shopify/claim', {}, pendingCookie()));
    expect(location(res).searchParams.get('shopify')).toBe('connected');
    expect(mocks.tx.tenant.create.mock.calls[0][0].data.name).toBe('acme');
  });

  it('webhooks parciales no frenan el reclamo, avisan en la query', async () => {
    mocks.registerShopifyWebhooks.mockResolvedValue({
      registered: [], alreadyPresent: [], failed: [{ topic: 'orders/paid', status: 500, body: '' }],
    });
    const res = await GET(makeRequest('/api/shopify/claim', {}, pendingCookie()));
    expect(location(res).searchParams.get('webhooks')).toBe('partial');
  });
});
