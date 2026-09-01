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

  it('otro error de la base: claim_failed, y se loguea shop/userId/code SIN el token ni la cookie', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.tx.tenant.create.mockRejectedValue(Object.assign(new Error('se cayó'), { code: 'P1001' }));
      const cookie = pendingCookie();
      const res = await GET(makeRequest('/api/shopify/claim', {}, cookie));
      expect(location(res).searchParams.get('shopify')).toBe('claim_failed');
      expect(pendingDeleted(res)).toBe(true);

      expect(spy).toHaveBeenCalledTimes(1);
      const [tag, ctx] = spy.mock.calls[0];
      expect(tag).toBe('[shopify/claim]');
      expect(ctx).toEqual({ shop: SHOP, userId: 'u-sesion', code: 'P1001', message: 'se cayó' });
      const volcado = JSON.stringify(spy.mock.calls[0]);
      expect(volcado).not.toContain('shpat_pend');
      expect(volcado).not.toContain(cookie[PENDING_INSTALL_COOKIE]);
    } finally {
      spy.mockRestore();
    }
  });

  it('dos reclamos seguidos con la misma cookie: el segundo da already_linked y NO vuelve a crear', async () => {
    const cookie = pendingCookie();
    const primera = await GET(makeRequest('/api/shopify/claim', {}, cookie));
    expect(location(primera).searchParams.get('shopify')).toBe('connected');
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);

    // La cookie se borró en la respuesta, pero un navegador viejo (o una
    // pestaña abierta antes) puede volver a presentarla: la tienda ya tiene
    // dueño y la transacción lo ve.
    mocks.tx.tenant.findFirst.mockResolvedValue({ id: 't-nuevo' });
    const segunda = await GET(makeRequest('/api/shopify/claim', {}, cookie));
    expect(location(segunda).searchParams.get('shopify')).toBe('already_linked');
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(mocks.registerShopifyWebhooks).toHaveBeenCalledTimes(1);
    expect(pendingDeleted(segunda)).toBe(true);
  });

  it('el user B con una cookie sellada en la instalación de A (ya reclamada por A): already_linked, sin create', async () => {
    const cookie = pendingCookie();
    await GET(makeRequest('/api/shopify/claim', {}, cookie));
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.tenant.create.mock.calls[0][0].data.userId).toBe('u-sesion');

    // B se loguea en su cuenta y presenta la misma cookie. La tienda ya es de
    // A: B no se la lleva ni se le crea nada.
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u-otro' });
    mocks.tx.tenant.findFirst.mockResolvedValue({ id: 't-nuevo' });
    const res = await GET(makeRequest('/api/shopify/claim', {}, cookie));
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);
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
    // El bonus de bienvenida es por usuario, no por tienda: sin este 0
    // explícito el schema regala 10 envíos por cada tienda reclamada.
    expect(data.shipmentCredits).toBe(0);

    // El tenant reclamado no queda activo: el banner de /settings tiene que
    // poder nombrar la tienda. Va el handle, nunca el token ni el email.
    expect(loc.searchParams.get('shop')).toBe('acme');
    expect(loc.search).not.toContain('shpat');

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
