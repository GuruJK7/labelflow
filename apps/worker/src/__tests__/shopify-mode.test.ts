// D27: selector de API por tenant. SHOPIFY_API_MODE manda; en auto, slug
// `shop-` → GraphQL, el resto REST, y un 403 REST (sin "required permission")
// memoriza GraphQL por tenant en memoria del proceso.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveShopifyApi,
  markRestForbidden,
  isRestForbiddenFor,
  isRestForbiddenError,
  isAppStoreSlug,
  getShopifyApiPolicy,
  _resetShopifyApiMemo,
} from '../shopify/mode';

function axiosErr(status: number, body: unknown) {
  return { isAxiosError: true, response: { status, data: body }, message: `status ${status}` };
}

const original = process.env.SHOPIFY_API_MODE;
beforeEach(() => {
  delete process.env.SHOPIFY_API_MODE;
  _resetShopifyApiMemo();
});
afterEach(() => {
  if (original === undefined) delete process.env.SHOPIFY_API_MODE;
  else process.env.SHOPIFY_API_MODE = original;
});

describe('getShopifyApiPolicy', () => {
  it('default auto; rest/graphql explícitos; basura → auto', () => {
    expect(getShopifyApiPolicy()).toBe('auto');
    process.env.SHOPIFY_API_MODE = 'rest';
    expect(getShopifyApiPolicy()).toBe('rest');
    process.env.SHOPIFY_API_MODE = ' GraphQL ';
    expect(getShopifyApiPolicy()).toBe('graphql');
    process.env.SHOPIFY_API_MODE = 'soap';
    expect(getShopifyApiPolicy()).toBe('auto');
  });
});

describe('resolveShopifyApi (auto)', () => {
  it('slug shop-<handle> (App Store) → graphql', () => {
    expect(isAppStoreSlug('shop-autoenvia-qa')).toBe(true);
    expect(resolveShopifyApi({ tenantId: 't1', slug: 'shop-autoenvia-qa' })).toBe('graphql');
  });

  it('slug normal (custom app) → rest', () => {
    expect(isAppStoreSlug('aura')).toBe(false);
    expect(isAppStoreSlug(null)).toBe(false);
    expect(resolveShopifyApi({ tenantId: 't2', slug: 'aura' })).toBe('rest');
    expect(resolveShopifyApi({ tenantId: 't3', slug: null })).toBe('rest');
  });

  it('markRestForbidden memoriza por tenantId y no contagia a otros', () => {
    markRestForbidden({ tenantId: 't2', slug: 'aura' }, '{"errors":"forbidden"}');
    expect(isRestForbiddenFor({ tenantId: 't2' })).toBe(true);
    expect(resolveShopifyApi({ tenantId: 't2', slug: 'aura' })).toBe('graphql');
    expect(resolveShopifyApi({ tenantId: 't9', slug: 'aura-2' })).toBe('rest');
  });

  it('sin tenantId usa storeUrl como clave; sin ninguna no memoriza', () => {
    markRestForbidden({ storeUrl: 'x.myshopify.com' }, 'forbidden');
    expect(resolveShopifyApi({ storeUrl: 'x.myshopify.com' })).toBe('graphql');
    markRestForbidden({}, 'forbidden');
    expect(resolveShopifyApi({})).toBe('rest');
  });
});

describe('env override', () => {
  it('SHOPIFY_API_MODE=rest fuerza REST aun para shop-* y aun con memo', () => {
    process.env.SHOPIFY_API_MODE = 'rest';
    markRestForbidden({ tenantId: 't1' }, 'forbidden');
    expect(resolveShopifyApi({ tenantId: 't1', slug: 'shop-x' })).toBe('rest');
  });

  it('SHOPIFY_API_MODE=graphql fuerza GraphQL para todos', () => {
    process.env.SHOPIFY_API_MODE = 'graphql';
    expect(resolveShopifyApi({ tenantId: 't2', slug: 'aura' })).toBe('graphql');
  });
});

describe('isRestForbiddenError', () => {
  it('403 sin "required permission" → prohibido (cuerpo disponible)', () => {
    expect(isRestForbiddenError(axiosErr(403, { errors: 'This app is not approved to use the REST Admin API.' })))
      .toEqual({ body: '{"errors":"This app is not approved to use the REST Admin API."}' });
    expect(isRestForbiddenError(axiosErr(403, 'Forbidden'))).toEqual({ body: 'Forbidden' });
  });

  it('403 de scopes faltantes ("required permission") NO conmuta: es ShopifyMissingScopesError', () => {
    expect(isRestForbiddenError(axiosErr(403, { errors: 'The api_client does not have the required permission(s).' }))).toBeNull();
  });

  it('401/404/429/500 y errores que no son de axios → null', () => {
    expect(isRestForbiddenError(axiosErr(401, {}))).toBeNull();
    expect(isRestForbiddenError(axiosErr(404, {}))).toBeNull();
    expect(isRestForbiddenError(axiosErr(429, {}))).toBeNull();
    expect(isRestForbiddenError(axiosErr(500, {}))).toBeNull();
    expect(isRestForbiddenError(new Error('boom'))).toBeNull();
    expect(isRestForbiddenError(undefined)).toBeNull();
  });
});
