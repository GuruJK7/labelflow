import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

process.env.ENCRYPTION_KEY = '55'.repeat(32);

const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantUpdate: vi.fn(),
  runLogDeleteMany: vi.fn(),
  getControlActor: vi.fn(),
}));
// Requisito 2.3.1: escribir dominio/token a mano es sólo-admin. Estos casos
// prueban el camino manual, así que el actor por defecto es admin; el 403 del
// comerciante vive en shopify-2-3-1-fugas-servidor.test.ts.
vi.mock('@/lib/control-scope', () => ({ getControlActor: mocks.getControlActor }));
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
import { SHOP_INFO_QUERY } from '@/lib/shopify-provision';

/** Respuesta con la forma que devuelve el Admin GraphQL API (HTTP 200 siempre). */
function gql(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

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
  mocks.getControlActor.mockResolvedValue({ userId: 'u1', isAdmin: true });
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
    const fetchMock = vi.fn().mockResolvedValue(
      gql({ data: { shop: { name: 'Mi Tienda', email: 'a@b.co', myshopifyDomain: 'mitienda.myshopify.com' } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await put({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_nuevo' });

    expect(res.status).toBe(200);
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
    // El token sí se verificó contra Shopify antes de guardarlo — y contra
    // GraphQL, no REST (requisito 2.2.4: una app pública nueva que consulte
    // recursos REST no se aprueba). Sin esta aserción el probe puede volver a
    // shop.json sin que nadie se entere hasta el rechazo del App Store.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://mitienda.myshopify.com/admin/api/2026-07/graphql.json');
    expect(String(url)).not.toContain('shop.json');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_nuevo');
    // La misma sonda que el alta del App Store y el onboarding, no una copia.
    expect(JSON.parse(String(init.body)).query).toBe(SHOP_INFO_QUERY);
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

/**
 * GraphQL contesta HTTP 200 aunque la consulta falle. En REST "token sin
 * alcances" era un 403 y `!res.ok` lo cazaba solo; acá el status ya no alcanza.
 * Sin el chequeo de `errors[]` se guarda un token que no despacha nada y el
 * comerciante se entera recién cuando falla la primera corrida.
 */
describe('PUT /api/v1/settings — el probe de Shopify lee errors[], no sólo el status', () => {
  beforeEach(() => {
    mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: 'mitienda.myshopify.com' });
  });

  it('HTTP 200 con ACCESS_DENIED → 422 y NO guarda el token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        gql({ data: null, errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] }),
      ),
    );
    const res = await put({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_nuevo' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'No se pudo conectar a Shopify. Verifica la URL y el token.' });
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('HTTP 401 (token revocado) → el mismo 422 de siempre', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(gql({ errors: [{ message: 'Invalid API key' }] }, 401)));
    const res = await put({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_nuevo' });
    expect(res.status).toBe(422);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('la red se cae → 422 "Error verificando conexion a Shopify", el texto que muestra el form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const res = await put({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_nuevo' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Error verificando conexion a Shopify' });
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });
});
