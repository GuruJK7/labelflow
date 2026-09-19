/**
 * 🔴 POR QUÉ ESTE TEST. `/api/shopify/entry` daba por "conectada" a toda tienda
 * con `shopifyToken != null`. Lo único que pone ese token en null es el webhook
 * `app/uninstalled`, que es best-effort: si no llegaba, reinstalar no volvía a
 * pedir OAuth nunca más. El revisor del App Store desinstala y reinstala.
 *
 * Acá se fija la traducción de "qué contestó Shopify" a "qué hacemos", que es
 * la decisión entera. Sin red: `vitalidadSegunPing` es pura, y
 * `vitalidadDelToken` se prueba con el resolvedor y el cliente mockeados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), graphql: vi.fn() }));
vi.mock('@/lib/shopify-access', () => ({ resolveShopifyAccessForTenant: mocks.resolve }));
vi.mock('@/lib/shopify-graphql', () => ({ shopifyGraphql: mocks.graphql }));

import { vitalidadSegunPing, vitalidadDelToken, SHOP_PING_QUERY, PING_TIMEOUT_MS } from '../shopify-token-liveness';

const TENANT = { id: 't1', shopifyStoreUrl: 'acme.myshopify.com', shopifyToken: 'enc' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ access: 'shpat_x', reason: null, legacy: false });
});

describe('vitalidadSegunPing (la tabla de decisión)', () => {
  it('200 con shop → viva', () => {
    expect(vitalidadSegunPing(200, true)).toBe('viva');
  });

  it('🔴 401 → muerta: el token fue revocado (la app se desinstaló)', () => {
    expect(vitalidadSegunPing(401, false)).toBe('muerta');
  });

  it('403 → muerta: la app no está autorizada en esa tienda', () => {
    expect(vitalidadSegunPing(403, false)).toBe('muerta');
  });

  it('5xx, 429, 0 → indeterminada: no se sabe, y no se adivina', () => {
    expect(vitalidadSegunPing(500, false)).toBe('indeterminada');
    expect(vitalidadSegunPing(502, false)).toBe('indeterminada');
    expect(vitalidadSegunPing(429, false)).toBe('indeterminada');
    expect(vitalidadSegunPing(0, false)).toBe('indeterminada');
  });

  it('200 sin shop en el cuerpo tampoco es viva', () => {
    // Un 200 con `data: null` es lo que da un ACCESS_DENIED o un cuerpo raro.
    expect(vitalidadSegunPing(200, false)).toBe('indeterminada');
  });
});

describe('vitalidadDelToken (con Shopify mockeado)', () => {
  it('resuelve el token y hace el ping mínimo con timeout corto', async () => {
    mocks.graphql.mockResolvedValue({ status: 200, data: { shop: { id: 'gid://shopify/Shop/1' } }, errors: [], bodyText: '' });
    expect(await vitalidadDelToken(TENANT, 'acme.myshopify.com')).toBe('viva');
    expect(mocks.resolve).toHaveBeenCalledWith(TENANT);
    const [shop, token, query, , opts] = mocks.graphql.mock.calls[0];
    expect(shop).toBe('acme.myshopify.com');
    expect(token).toBe('shpat_x');
    expect(query).toBe(SHOP_PING_QUERY);
    expect(opts).toEqual({ timeoutMs: PING_TIMEOUT_MS });
  });

  it('🔴 Shopify contesta 401 → muerta (el caso de la reinstalación sin webhook)', async () => {
    mocks.graphql.mockResolvedValue({ status: 401, data: null, errors: [], bodyText: '' });
    expect(await vitalidadDelToken(TENANT, 'acme.myshopify.com')).toBe('muerta');
  });

  it("la renovación dio invalid_grant ('reinstall') → muerta sin llegar a pinguear", async () => {
    mocks.resolve.mockResolvedValue({ access: null, reason: 'reinstall', message: '…' });
    expect(await vitalidadDelToken(TENANT, 'acme.myshopify.com')).toBe('muerta');
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it('sin token o ilegible → muerta: con eso no se puede operar', async () => {
    mocks.resolve.mockResolvedValue({ access: null, reason: 'no-token', message: '…' });
    expect(await vitalidadDelToken(TENANT, 'acme.myshopify.com')).toBe('muerta');
    mocks.resolve.mockResolvedValue({ access: null, reason: 'unreadable', message: '…' });
    expect(await vitalidadDelToken(TENANT, 'acme.myshopify.com')).toBe('muerta');
  });

  it("la renovación falló por red ('refresh-failed') → indeterminada, no muerta", async () => {
    mocks.resolve.mockResolvedValue({ access: null, reason: 'refresh-failed', message: '…' });
    expect(await vitalidadDelToken(TENANT, 'acme.myshopify.com')).toBe('indeterminada');
  });

  it('el ping tira (timeout, red) → indeterminada, nunca una excepción hacia /entry', async () => {
    mocks.graphql.mockRejectedValue(new Error('timeout'));
    expect(await vitalidadDelToken(TENANT, 'acme.myshopify.com')).toBe('indeterminada');
  });

  it('un token legacy (shpat_ pegado a mano) también se pinguea: si vive, viva', async () => {
    mocks.resolve.mockResolvedValue({ access: 'shpat_legacy', reason: null, legacy: true });
    mocks.graphql.mockResolvedValue({ status: 200, data: { shop: { id: 'gid://shopify/Shop/9' } }, errors: [], bodyText: '' });
    expect(await vitalidadDelToken(TENANT, 'acme.myshopify.com')).toBe('viva');
  });
});
