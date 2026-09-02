// D27: selector de API por tenant. SHOPIFY_API_MODE manda; en auto, slug
// EXACTAMENTE igual a tenantSlugForShop(storeUrl) → GraphQL, el resto REST, y
// sólo un 403 REST que diga positivamente "app sin REST" (y en un tenant al
// que REST nunca le respondió 2xx) memoriza GraphQL en memoria del proceso.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import {
  resolveShopifyApi,
  markRestForbidden,
  markRestWorking,
  isRestKnownWorking,
  isRestForbiddenFor,
  isRestForbiddenError,
  isAppStoreSlug,
  tenantSlugForShop,
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

describe('tenantSlugForShop (réplica de apps/web/lib/shopify-provision.ts)', () => {
  it('handle ≤ 40 → shop-<handle>; caracteres fuera de [a-z0-9-] se eliminan', () => {
    expect(tenantSlugForShop('autoenvia-qa.myshopify.com')).toBe('shop-autoenvia-qa');
    expect(tenantSlugForShop('Mi_Tienda.myshopify.com')).toBe('shop-iienda'); // igual que web: sin toLowerCase, se eliminan M, _ y T
    expect(tenantSlugForShop('a'.repeat(40) + '.myshopify.com')).toBe('shop-' + 'a'.repeat(40));
  });

  it('handle > 40 → shop-<31 primeros>-<sha256[0:8] del handle completo> (vector fijo)', () => {
    const handle = 'una-tienda-con-un-handle-larguisimo-de-mas-de-cuarenta'; // 54 chars
    expect(handle).toHaveLength(54);
    const slug = tenantSlugForShop(`${handle}.myshopify.com`);
    // Vector calculado una vez con node crypto: sha256(handle)[0:8] = f2deba4e.
    expect(slug).toBe('shop-una-tienda-con-un-handle-largui-f2deba4e');
    expect(slug).toBe(`shop-${handle.slice(0, 31)}-${createHash('sha256').update(handle).digest('hex').slice(0, 8)}`);
    expect(slug.length).toBeLessThanOrEqual(45);
  });
});

describe('isAppStoreSlug: igualdad exacta con el slug determinista, no prefijo', () => {
  it('slug == tenantSlugForShop(storeUrl) → App Store', () => {
    expect(isAppStoreSlug('shop-autoenvia-qa', 'autoenvia-qa.myshopify.com')).toBe(true);
    expect(isAppStoreSlug('shop-una-tienda-con-un-handle-largui-f2deba4e', 'una-tienda-con-un-handle-larguisimo-de-mas-de-cuarenta.myshopify.com')).toBe(true);
  });

  it('slugs manuales que EMPIEZAN con shop- (email shop@…, tienda "Shop Marca") NO son App Store', () => {
    // signup: `shop@marca.com` → local-part + '-' + Date.now().toString(36)
    expect(isAppStoreSlug('shop-m1abcd', 'marca.myshopify.com')).toBe(false);
    // signup: `shop.marca@gmail.com`
    expect(isAppStoreSlug('shop-marca-m1abcd', 'marca.myshopify.com')).toBe(false);
    // tenants/route.ts: tienda adicional "Shop Marca" + sufijo
    expect(isAppStoreSlug('shop-marca-xxxxxx', 'shop-marca.myshopify.com')).toBe(false);
    // Un prefijo del handle real tampoco alcanza.
    expect(isAppStoreSlug('shop-autoenvia', 'autoenvia-qa.myshopify.com')).toBe(false);
  });

  it('sin slug o sin storeUrl → false (REST)', () => {
    expect(isAppStoreSlug(null, 'x.myshopify.com')).toBe(false);
    expect(isAppStoreSlug('shop-x', null)).toBe(false);
    expect(isAppStoreSlug('shop-x', '')).toBe(false);
    expect(isAppStoreSlug('aura', 'aura.myshopify.com')).toBe(false);
  });
});

describe('resolveShopifyApi (auto)', () => {
  it('tenant del App Store → graphql', () => {
    expect(resolveShopifyApi({ tenantId: 't1', slug: 'shop-autoenvia-qa', storeUrl: 'autoenvia-qa.myshopify.com' })).toBe('graphql');
  });

  it('slug normal (custom app) → rest; slug shop-… manual → rest', () => {
    expect(resolveShopifyApi({ tenantId: 't2', slug: 'aura', storeUrl: 'aura.myshopify.com' })).toBe('rest');
    expect(resolveShopifyApi({ tenantId: 't3', slug: null, storeUrl: 'aura.myshopify.com' })).toBe('rest');
    expect(resolveShopifyApi({ tenantId: 't4', slug: 'shop-marca-m1abcd', storeUrl: 'marca.myshopify.com' })).toBe('rest');
    // Sin storeUrl no hay con qué comparar: REST.
    expect(resolveShopifyApi({ tenantId: 't5', slug: 'shop-autoenvia-qa' })).toBe('rest');
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

  it('markRestWorking memoriza por tenant y se limpia con el reset', () => {
    expect(isRestKnownWorking({ tenantId: 't2' })).toBe(false);
    markRestWorking({ tenantId: 't2', slug: 'aura' });
    expect(isRestKnownWorking({ tenantId: 't2' })).toBe(true);
    expect(isRestKnownWorking({ tenantId: 't3' })).toBe(false);
    markRestWorking({});
    expect(isRestKnownWorking({})).toBe(false);
    _resetShopifyApiMemo();
    expect(isRestKnownWorking({ tenantId: 't2' })).toBe(false);
  });
});

describe('env override', () => {
  it('SHOPIFY_API_MODE=rest fuerza REST aun para el App Store y aun con memo', () => {
    process.env.SHOPIFY_API_MODE = 'rest';
    markRestForbidden({ tenantId: 't1' }, 'forbidden');
    expect(resolveShopifyApi({ tenantId: 't1', slug: 'shop-x', storeUrl: 'x.myshopify.com' })).toBe('rest');
  });

  it('SHOPIFY_API_MODE=graphql fuerza GraphQL para todos', () => {
    process.env.SHOPIFY_API_MODE = 'graphql';
    expect(resolveShopifyApi({ tenantId: 't2', slug: 'aura' })).toBe('graphql');
  });
});

describe('isRestForbiddenError: match POSITIVO, no lista negra', () => {
  it('403 que dice que la app no puede usar la REST Admin API → prohibido (cuerpo disponible)', () => {
    expect(isRestForbiddenError(axiosErr(403, { errors: 'This app is not approved to use the REST Admin API.' })))
      .toEqual({ body: '{"errors":"This app is not approved to use the REST Admin API."}' });
    expect(isRestForbiddenError(axiosErr(403, 'The REST Admin API is not available for this app'))).toEqual({ body: 'The REST Admin API is not available for this app' });
  });

  it('403 de scopes faltantes ("required permission") NO conmuta: es ShopifyMissingScopesError', () => {
    expect(isRestForbiddenError(axiosErr(403, { errors: 'The api_client does not have the required permission(s).' }))).toBeNull();
  });

  it('403 "merchant approval for read_orders / read_all_orders scope" (custom app con REST) NO conmuta', () => {
    expect(isRestForbiddenError(axiosErr(403, { errors: '[API] This action requires merchant approval for read_orders scope.' }))).toBeNull();
    expect(isRestForbiddenError(axiosErr(403, { errors: '[API] This action requires merchant approval for read_all_orders scope.' }))).toBeNull();
    // Aunque el cuerpo mencione la REST Admin API, "merchant approval" gana.
    expect(isRestForbiddenError(axiosErr(403, 'REST Admin API: This action requires merchant approval for read_orders scope.'))).toBeNull();
  });

  it('403 con cualquier otro texto (Forbidden pelado, tienda marcada, vacío) NO conmuta', () => {
    expect(isRestForbiddenError(axiosErr(403, 'Forbidden'))).toBeNull();
    expect(isRestForbiddenError(axiosErr(403, { errors: 'Unavailable Shop' }))).toBeNull();
    expect(isRestForbiddenError(axiosErr(403, undefined))).toBeNull();
    expect(isRestForbiddenError(axiosErr(403, {}))).toBeNull();
  });

  it('401/404/429/500 y errores que no son de axios → null', () => {
    expect(isRestForbiddenError(axiosErr(401, {}))).toBeNull();
    expect(isRestForbiddenError(axiosErr(404, {}))).toBeNull();
    expect(isRestForbiddenError(axiosErr(429, {}))).toBeNull();
    expect(isRestForbiddenError(axiosErr(500, { errors: 'REST Admin API' }))).toBeNull();
    expect(isRestForbiddenError(new Error('boom'))).toBeNull();
    expect(isRestForbiddenError(undefined)).toBeNull();
  });
});
