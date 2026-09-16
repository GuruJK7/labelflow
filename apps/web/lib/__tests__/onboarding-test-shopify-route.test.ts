// Requisito 2.2.4 del App Store: las apps públicas nuevas (posteriores al
// 1/4/2025) no pueden tocar el REST Admin API. Este probe pegaba a shop.json;
// ahora corre la MISMA query GraphQL que el alta desde el App Store
// (SHOP_INFO_QUERY). El contrato de salida no cambió.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '66'.repeat(32);

const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantUpdate: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  getControlActor: vi.fn(),
}));
// Requisito 2.3.1: esta ruta ES el alta manual y quedó sólo-admin. Los casos de
// acá prueban el probe contra Shopify, así que el actor por defecto es admin; el
// 403 del comerciante vive en shopify-2-3-1-fugas-servidor.test.ts.
vi.mock('@/lib/control-scope', () => ({ getControlActor: mocks.getControlActor }));
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
import { SHOP_INFO_QUERY } from '../shopify-provision';
import { fakeTenantFindFirst } from './_shopify-route-utils';

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: true, subscriptionStatus: 'ACTIVE',
  });
  mocks.tenantUpdate.mockResolvedValue({});
  mocks.getControlActor.mockResolvedValue({ userId: 'u1', isAdmin: true });
  // Por defecto el tenant no tiene tienda y ningún otro tenant tiene el dominio.
  mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: null });
  mocks.tenantFindFirst.mockResolvedValue(null);
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({
        data: { shop: { name: 'Mi Tienda', email: 'due@tienda.com', myshopifyDomain: 'mitienda.myshopify.com' } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** Respuesta cruda de graphql.json (200 aunque traiga `errors`). */
function gql(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://mitienda.myshopify.com/admin/api/2026-07/graphql.json',
    );
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

/**
 * Requisito 2.2.4 del App Store. Sin esto el probe vuelve a REST sin que nadie
 * se entere: el self-review lo marca FALLANDO y la app no se aprueba. El
 * contrato de salida (200 → { data: { ok, shopName } }, errores → { error })
 * no cambió: sólo cambió con quién habla.
 */
describe('POST /api/v1/onboarding/test-shopify — el probe es GraphQL, no REST (2.2.4)', () => {
  it('POST a graphql.json con SHOP_INFO_QUERY y el token en el header; nunca shop.json', async () => {
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(200);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://mitienda.myshopify.com/admin/api/2026-07/graphql.json');
    expect(String(url)).not.toContain('shop.json');
    expect(String(url)).not.toContain('/admin/api/2024-01/');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_0123456789');
    // La misma query que usa el alta desde el App Store, no una copia.
    expect(JSON.parse(String(init.body)).query).toBe(SHOP_INFO_QUERY);
  });

  it('el nombre de la tienda sale de data.shop.name y se devuelve como shopName', async () => {
    fetchSpy.mockResolvedValue(gql({ data: { shop: { name: 'Nórdika', email: 'a@b.co', myshopifyDomain: 'x.myshopify.com' } } }));
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, shopName: 'Nórdika' } });
  });

  it('shop sin name → shopName null, pero guarda igual (contrato del REST viejo)', async () => {
    fetchSpy.mockResolvedValue(gql({ data: { shop: { name: null, email: 'a@b.co' } } }));
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, shopName: null } });
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
  });
});

/**
 * GraphQL contesta 200 aunque la consulta falle: el status por sí solo ya no
 * alcanza. Si `errors[]` pasa por OK se guarda un token que no sirve y el
 * comerciante avanza el wizard con la tienda rota.
 */
describe('POST /api/v1/onboarding/test-shopify — errores de GraphQL', () => {
  it('HTTP 200 con ACCESS_DENIED → 422 con el mensaje de alcances, y NO guarda', async () => {
    fetchSpy.mockResolvedValue(
      gql({ data: null, errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] }),
    );
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('Token rechazado por Shopify');
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('HTTP 200 con un error genérico (THROTTLED) → 422 y NO guarda', async () => {
    fetchSpy.mockResolvedValue(
      gql({ data: null, errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
    );
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(422);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('HTTP 401 (token inválido; `errors` viene como string) → 422 de token rechazado', async () => {
    fetchSpy.mockResolvedValue(new Response('{"errors":"[API] Invalid API key or access token"}', { status: 401 }));
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('Token rechazado por Shopify');
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('HTTP 500 → 422 informando el status, y NO guarda', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 500 }));
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('500');
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('timeout de red → 422 "tardó demasiado", y NO guarda', async () => {
    fetchSpy.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    const res = await post({ shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'shpat_0123456789' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('tardó demasiado');
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });
});
