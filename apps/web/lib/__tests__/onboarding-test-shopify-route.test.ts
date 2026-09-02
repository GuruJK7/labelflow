import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '66'.repeat(32);

const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantUpdate: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { update: mocks.tenantUpdate, findFirst: mocks.tenantFindFirst, findUnique: mocks.tenantFindUnique },
  },
}));

import { POST } from '@/app/api/v1/onboarding/test-shopify/route';
import { decrypt } from '../encryption';
import { fakeTenantFindFirst } from './_shopify-route-utils';

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: true, subscriptionStatus: 'ACTIVE',
  });
  mocks.tenantUpdate.mockResolvedValue({});
  // Por defecto el tenant no tiene tienda y ningún otro tenant tiene el dominio.
  mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: null });
  mocks.tenantFindFirst.mockResolvedValue(null);
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

/**
 * Trial farmeable (revisión 2026-09-02): el paso 2 por token manual no
 * chequeaba si el dominio ya era de otro tenant. Una cuenta nueva podía pegar
 * el token de una tienda ajena, cobrarse los 5 envíos gratis otra vez sobre la
 * misma tienda y, de paso, hacer que el worker despache cada pedido dos veces.
 * Mismo criterio que /install, /claim y settings PUT (lib/shop-domain-taken).
 */
describe('POST /api/v1/onboarding/test-shopify — dominio ya vinculado a otro tenant', () => {
  it('dominio de OTRO tenant (guardado con mayúsculas): 409, sin llamar a Shopify ni escribir', async () => {
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 'tenant-ajeno', shopifyStoreUrl: 'MiTienda.myshopify.com' }]),
    );
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Esa tienda ya está conectada a otra cuenta. Escribinos y lo resolvemos.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('busca el conflicto insensible a mayúsculas y excluyéndose a sí mismo', async () => {
    await post({ shopifyStoreUrl: 'MiTienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(mocks.tenantFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.tenantFindFirst.mock.calls[0][0].where).toEqual({
      shopifyStoreUrl: { equals: 'mitienda.myshopify.com', mode: 'insensitive' },
      id: { not: 'tenant-1' },
    });
  });

  it('el dominio es del PROPIO tenant: no es conflicto, prueba y guarda', async () => {
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 'tenant-1', shopifyStoreUrl: 'mitienda.myshopify.com' }]),
    );
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(200);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
  });

  it('dominio sin cambio (ya guardado en el tenant) + token nuevo: no consulta duplicados y guarda (D21)', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: 'MiTienda.myshopify.com' });
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 'tenant-compartido', shopifyStoreUrl: 'mitienda.myshopify.com' }]),
    );
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_nuevo_token' });
    expect(res.status).toBe(200);
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decrypt(mocks.tenantUpdate.mock.calls[0][0].data.shopifyToken)).toBe('shpat_nuevo_token');
  });

  it('un dominio inválido se rechaza antes de consultar la base', async () => {
    const res = await post({ shopifyStoreUrl: 'mitienda.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(400);
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled();
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
  });
});
