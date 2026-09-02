// D29 (revisión): el warm-up previo a encolar un "Ejecutar" manual tiene que
// dejar al worker (sin secret en Render) con ~1 h entera de token, no con
// los 6 min que el margen corto dejaba pasar.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '77'.repeat(32);
process.env.SHOPIFY_API_KEY = 'client-de-test';
process.env.SHOPIFY_API_SECRET = 'secreto-de-test';

const { dbState, findUnique, updateMany } = vi.hoisted(() => {
  const dbState: { cipher: string | null } = { cipher: null };
  const findUnique = vi.fn(async () => ({ id: 'tenant-warm', shopifyStoreUrl: 'acme.myshopify.com', shopifyToken: dbState.cipher }));
  const updateMany = vi.fn(async (args: { where: { id: string; shopifyToken: string }; data: { shopifyToken: string } }) => {
    if (dbState.cipher === args.where.shopifyToken) {
      dbState.cipher = args.data.shopifyToken;
      return { count: 1 };
    }
    return { count: 0 };
  });
  return { dbState, findUnique, updateMany };
});
vi.mock('@/lib/db', () => ({ db: { tenant: { findUnique, updateMany } } }));

import { warmShopifyToken, shopifyAccessForTenant } from '@/lib/shopify-access';
import { serializeShopifyCredential, parseShopifyCredential, __resetShopifyTokenState } from '@/lib/shopify-token';
import { encrypt, decrypt } from '@/lib/encryption';

const HORA = 3600 * 1000;

function envelope(expIn: number): string {
  return encrypt(
    serializeShopifyCredential({
      access: 'shpat_actual',
      exp: Date.now() + expIn,
      refresh: 'shprt_actual',
      refreshExp: Date.now() + 90 * 24 * HORA,
      legacy: false,
    }),
  );
}

const fetchMock = vi.fn(async () =>
  new Response(
    JSON.stringify({ access_token: 'shpat_rotado', expires_in: 3600, refresh_token: 'shprt_rotado', refresh_token_expires_in: 7776000 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ),
);

beforeEach(() => {
  __resetShopifyTokenState();
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

describe('warmShopifyToken', () => {
  it('con 6 min de vida (que el margen corto dejaría pasar) rota y persiste: el worker arranca con ~1 h', async () => {
    dbState.cipher = envelope(6 * 60 * 1000);
    // El margen corto no lo tocaría:
    expect(await shopifyAccessForTenant({ id: 'tenant-warm', shopifyStoreUrl: 'acme.myshopify.com', shopifyToken: dbState.cipher })).toBe('shpat_actual');
    expect(fetchMock).not.toHaveBeenCalled();

    await warmShopifyToken('tenant-warm');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const cred = parseShopifyCredential(decrypt(dbState.cipher as string));
    expect(cred?.access).toBe('shpat_rotado');
    expect((cred?.exp ?? 0) - Date.now()).toBeGreaterThan(59 * 60 * 1000);
  });

  it('con 58 min de vida no rota (ya tiene casi la hora entera)', async () => {
    dbState.cipher = envelope(58 * 60 * 1000);
    await warmShopifyToken('tenant-warm');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('legacy y sin token: no hace nada; y nunca tira', async () => {
    dbState.cipher = encrypt('shpat_custom_app');
    await warmShopifyToken('tenant-warm');
    dbState.cipher = null;
    await warmShopifyToken('tenant-warm');
    findUnique.mockRejectedValueOnce(new Error('db caída'));
    await expect(warmShopifyToken('tenant-warm')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
