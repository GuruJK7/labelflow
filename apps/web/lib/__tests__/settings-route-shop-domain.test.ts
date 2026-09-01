import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

process.env.ENCRYPTION_KEY = '55'.repeat(32);

const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantUpdate: vi.fn(),
  runLogDeleteMany: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { findFirst: mocks.tenantFindFirst, findUnique: mocks.tenantFindUnique, update: mocks.tenantUpdate },
    runLog: { deleteMany: mocks.runLogDeleteMany },
  },
}));

import { PUT } from '@/app/api/v1/settings/route';
import { fakeTenantFindFirst } from './_shopify-route-utils';

function put(body: unknown) {
  return PUT(
    new NextRequest('https://autoenvia.com/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: true, subscriptionStatus: 'ACTIVE',
  });
  mocks.tenantFindFirst.mockResolvedValue(null);
  // Por defecto el tenant no tiene tienda: cualquier dominio que llegue es un cambio.
  mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: null });
  mocks.tenantUpdate.mockResolvedValue({});
  vi.unstubAllGlobals();
});

/**
 * El dominio de Shopify es la clave con la que el App Store, /claim y el
 * webhook encuentran al tenant, y Shopify siempre lo manda en minúsculas.
 * Guardarlo con mayúsculas era "perder" la tienda para todo ese flujo (D18).
 */
describe('PUT /api/v1/settings — shopifyStoreUrl', () => {
  it('guarda el dominio en minúsculas aunque venga con mayúsculas', async () => {
    const res = await put({ shopifyStoreUrl: 'MiTienda.myshopify.com' });
    expect(res.status).toBe(200);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.tenantUpdate.mock.calls[0][0]).toEqual({
      where: { id: 'tenant-1' },
      data: { shopifyStoreUrl: 'mitienda.myshopify.com' },
    });
  });

  it('sigue rechazando lo que no es un dominio de Shopify', async () => {
    const res = await put({ shopifyStoreUrl: 'mitienda.com' });
    expect(res.status).toBe(400);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('busca si otro tenant ya tiene ese dominio, sin distinguir mayúsculas y excluyéndose a sí mismo', async () => {
    await put({ shopifyStoreUrl: 'MiTienda.myshopify.com' });
    expect(mocks.tenantFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.tenantFindFirst.mock.calls[0][0].where).toEqual({
      shopifyStoreUrl: { equals: 'mitienda.myshopify.com', mode: 'insensitive' },
      id: { not: 'tenant-1' },
    });
  });

  it('el dominio ya es de OTRO tenant (guardado con mayúsculas): 409 y no escribe', async () => {
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 'tenant-ajeno', shopifyStoreUrl: 'MiTienda.myshopify.com' }]),
    );
    const res = await put({ shopifyStoreUrl: 'mitienda.myshopify.com' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Esa tienda ya está conectada a otra cuenta. Escribinos y lo resolvemos.',
    });
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('el dominio es del PROPIO tenant: no es conflicto, guarda', async () => {
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 'tenant-1', shopifyStoreUrl: 'MiTienda.myshopify.com' }]),
    );
    const res = await put({ shopifyStoreUrl: 'mitienda.myshopify.com' });
    expect(res.status).toBe(200);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
  });

  it('sin shopifyStoreUrl en el body no consulta duplicados', async () => {
    await put({ storeName: 'Acme' });
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled();
    expect(mocks.tenantUpdate.mock.calls[0][0].data).toEqual({ storeName: 'Acme' });
  });
});

/**
 * Dos tenants pueden compartir tienda a propósito (el worker lo contempla con
 * `sharedTenantIds`; incidente Aura 2026-05-08). "Guardar token" manda siempre
 * el dominio que cargó del GET: si el chequeo de duplicados saltara también
 * cuando el dominio no cambió, esos tenants no podrían rotar el token nunca,
 * porque /install y /callback ya les devuelven already_linked (D21).
 */
describe('PUT /api/v1/settings — el 409 sólo cuando el dominio CAMBIA', () => {
  const tabla = [
    { id: 'tenant-1', shopifyStoreUrl: 'MiTienda.myshopify.com' },
    { id: 'tenant-ajeno', shopifyStoreUrl: 'mitienda.myshopify.com' },
  ];

  it('lee el dominio actual del propio tenant, y nada más', async () => {
    await put({ shopifyStoreUrl: 'otra.myshopify.com' });
    expect(mocks.tenantFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.tenantFindUnique.mock.calls[0][0]).toEqual({
      where: { id: 'tenant-1' },
      select: { shopifyStoreUrl: true },
    });
  });

  it('tienda compartida, dominio sin cambio (guardado con mayúsculas) + token nuevo: 200, no consulta duplicados, guarda en minúsculas', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: 'MiTienda.myshopify.com' });
    mocks.tenantFindFirst.mockImplementation(fakeTenantFindFirst(tabla));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const res = await put({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_nuevo' });

    expect(res.status).toBe(200);
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
    // El token sí se verificó contra Shopify antes de guardarlo.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://mitienda.myshopify.com/admin/api/2024-01/shop.json');
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
    const { where, data } = mocks.tenantUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: 'tenant-1' });
    expect(data.shopifyStoreUrl).toBe('mitienda.myshopify.com');
    expect(typeof data.shopifyToken).toBe('string');
    expect(data.shopifyToken).not.toBe('shpat_nuevo'); // cifrado, no en claro
  });

  it('tienda compartida pero el dominio CAMBIA a uno de otro tenant: 409 y no escribe', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: 'MiTienda.myshopify.com' });
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([...tabla, { id: 'tenant-3', shopifyStoreUrl: 'tercera.myshopify.com' }]),
    );
    const res = await put({ shopifyStoreUrl: 'Tercera.myshopify.com' });
    expect(res.status).toBe(409);
    expect(mocks.tenantFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('el dominio cambia a uno libre: consulta duplicados y guarda', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: 'MiTienda.myshopify.com' });
    mocks.tenantFindFirst.mockImplementation(fakeTenantFindFirst(tabla));
    const res = await put({ shopifyStoreUrl: 'libre.myshopify.com' });
    expect(res.status).toBe(200);
    expect(mocks.tenantFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.tenantUpdate.mock.calls[0][0].data).toEqual({ shopifyStoreUrl: 'libre.myshopify.com' });
  });
});
