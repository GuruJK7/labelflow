// D29 (revisión): lo que un job del worker recibe de shopify/access.ts.
//   - resolveShopifyAccessForJob arranca con margen de 55 min (rota un token
//     que todavía tiene media hora),
//   - shopifyTokenSourceForTenant: legacy → string fijo; expirable → proveedor
//     que relee la fila en cada request, ve rotaciones ajenas, y con
//     forceRefresh rota aunque el par esté fresco.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '66'.repeat(32);
process.env.SHOPIFY_API_KEY = 'client-de-test';
process.env.SHOPIFY_API_SECRET = 'secreto-de-test';

const { dbState, findUnique, updateMany } = vi.hoisted(() => {
  const dbState: { cipher: string | null } = { cipher: null };
  const findUnique = vi.fn(async () => ({ id: 'tenant-access', shopifyStoreUrl: 'acme.myshopify.com', shopifyToken: dbState.cipher }));
  const updateMany = vi.fn(async (args: { where: { id: string; shopifyToken: string }; data: { shopifyToken: string } }) => {
    if (dbState.cipher === args.where.shopifyToken) {
      dbState.cipher = args.data.shopifyToken;
      return { count: 1 };
    }
    return { count: 0 };
  });
  return { dbState, findUnique, updateMany };
});
vi.mock('../db', () => ({ db: { tenant: { findUnique, updateMany } } }));

import { resolveShopifyAccessForJob, shopifyTokenSourceForTenant } from '../shopify/access';
import { serializeShopifyCredential, __resetShopifyTokenState, type ShopifyCredential } from '../shopify/token';
import { encrypt } from '../encryption';

const TENANT = 'tenant-access';
const SHOP = 'acme.myshopify.com';
const HORA = 3600 * 1000;

function envelope(over: Partial<ShopifyCredential> = {}): string {
  return encrypt(
    serializeShopifyCredential({
      access: 'shpat_actual',
      exp: Date.now() + HORA,
      refresh: 'shprt_actual',
      refreshExp: Date.now() + 90 * 24 * HORA,
      legacy: false,
      ...over,
    }),
  );
}

let rotaciones = 0;
const fetchMock = vi.fn(async () => {
  rotaciones++;
  return new Response(
    JSON.stringify({ access_token: `shpat_rotado_${rotaciones}`, expires_in: 3600, refresh_token: `shprt_rotado_${rotaciones}`, refresh_token_expires_in: 7776000 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});

beforeEach(() => {
  __resetShopifyTokenState();
  rotaciones = 0;
  fetchMock.mockClear();
  findUnique.mockClear();
  updateMany.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveShopifyAccessForJob', () => {
  it('rota un token con 30 min de vida (margen de job), cosa que el margen corto no haría', async () => {
    dbState.cipher = envelope({ exp: Date.now() + 30 * 60 * 1000 });
    const r = await resolveShopifyAccessForJob({ id: TENANT, shopifyStoreUrl: SHOP, shopifyToken: dbState.cipher });
    expect(r.access).toBe('shpat_rotado_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('legacy: el string tal cual, sin tocar Shopify', async () => {
    const cipher = encrypt('shpat_custom_app');
    const r = await resolveShopifyAccessForJob({ id: TENANT, shopifyStoreUrl: SHOP, shopifyToken: cipher });
    expect(r).toEqual({ access: 'shpat_custom_app', reason: null, legacy: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('shopifyTokenSourceForTenant', () => {
  it('legacy → el string fijo (el cliente queda como siempre; cero lecturas de base)', async () => {
    const cipher = encrypt('shpat_custom_app');
    const initial = await resolveShopifyAccessForJob({ id: TENANT, shopifyStoreUrl: SHOP, shopifyToken: cipher });
    const source = shopifyTokenSourceForTenant(TENANT, initial);
    expect(source).toBe('shpat_custom_app');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('expirable → proveedor que relee la fila en cada llamada y ve la rotación que hizo otro proceso', async () => {
    dbState.cipher = envelope();
    const initial = await resolveShopifyAccessForJob({ id: TENANT, shopifyStoreUrl: SHOP, shopifyToken: dbState.cipher });
    const source = shopifyTokenSourceForTenant(TENANT, initial);
    expect(typeof source).toBe('function');
    const provider = source as () => Promise<string>;

    expect(await provider()).toBe('shpat_actual');
    // La web (u otro worker) rotó entre dos requests del job.
    dbState.cipher = envelope({ access: 'shpat_de_la_web', refresh: 'shprt_de_la_web' });
    expect(await provider()).toBe('shpat_de_la_web');
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forceRefresh (reintento por 401) rota aunque el par esté fresco y persiste el nuevo antes de devolverlo', async () => {
    dbState.cipher = envelope();
    const initial = await resolveShopifyAccessForJob({ id: TENANT, shopifyStoreUrl: SHOP, shopifyToken: dbState.cipher });
    const provider = shopifyTokenSourceForTenant(TENANT, initial) as (o?: { forceRefresh?: boolean }) => Promise<string>;
    const antes = dbState.cipher;
    expect(await provider({ forceRefresh: true })).toBe('shpat_rotado_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dbState.cipher).not.toBe(antes);
    // La siguiente llamada normal ya ve el par rotado desde la base.
    expect(await provider()).toBe('shpat_rotado_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el proveedor tira con el motivo accionable si el token desapareció o ya no sirve', async () => {
    dbState.cipher = envelope();
    const initial = await resolveShopifyAccessForJob({ id: TENANT, shopifyStoreUrl: SHOP, shopifyToken: dbState.cipher });
    const provider = shopifyTokenSourceForTenant(TENANT, initial) as () => Promise<string>;
    dbState.cipher = null; // uninstalled
    await expect(provider()).rejects.toThrow('no está conectado');
  });

  it('con una resolución fallida tira en el acto (los jobs ya cortaron antes)', () => {
    expect(() =>
      shopifyTokenSourceForTenant(TENANT, { access: null, reason: 'reinstall', message: 'reinstalar la app' }),
    ).toThrow('reinstalar la app');
  });
});
