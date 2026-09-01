import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '66'.repeat(32);

const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantUpdate: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({ db: { tenant: { update: mocks.tenantUpdate } } }));

import { POST } from '@/app/api/v1/onboarding/test-shopify/route';
import { decrypt } from '../encryption';

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: true, subscriptionStatus: 'ACTIVE',
  });
  mocks.tenantUpdate.mockResolvedValue({});
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ shop: { name: 'Mi Tienda' } }), { status: 200 }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function post(body: unknown) {
  return POST(
    new Request('https://autoenvia.com/api/v1/onboarding/test-shopify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/v1/onboarding/test-shopify — shopifyStoreUrl', () => {
  it('prueba contra Shopify y persiste el dominio en minúsculas (D18)', async () => {
    const res = await post({ shopifyStoreUrl: 'MiTienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(200);
    // El probe también va en minúsculas: es el mismo host para Shopify, y así
    // lo que se verificó es exactamente lo que se guardó.
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://mitienda.myshopify.com/admin/api/2024-01/shop.json');
    const upd = mocks.tenantUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'tenant-1' });
    expect(upd.data.shopifyStoreUrl).toBe('mitienda.myshopify.com');
    expect(decrypt(upd.data.shopifyToken)).toBe('shpat_0123456789');
  });

  it('rechaza un dominio que no es de Shopify antes de llamar a nadie', async () => {
    const res = await post({ shopifyStoreUrl: 'mitienda.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });
});
