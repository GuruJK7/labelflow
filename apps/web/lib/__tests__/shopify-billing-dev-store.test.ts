/**
 * 🔴 POR QUÉ ESTE TEST. `isDevelopmentStore` convertía cualquier respuesta que
 * no fuera 200-con-`partnerDevelopment: true` en `false`, y `false` es "cargo
 * REAL". En una tienda de desarrollo Shopify rechaza un cargo real: un 429 o
 * un hipo de red en esta consulta le dejaba al revisor del App Store un 502
 * sin explicación justo al intentar comprar.
 *
 * La regla nueva: un "no sé" no es un "no". Se reintenta una vez y, si sigue
 * sin resolverse, se tira `ShopifyPlanUnresolvedError`. Nunca se adivina.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ graphql: vi.fn() }));
vi.mock('@/lib/shopify-graphql', () => ({
  shopifyGraphql: mocks.graphql,
  SHOPIFY_GRAPHQL_API_VERSION: '2026-07',
}));

import { isDevelopmentStore, ShopifyPlanUnresolvedError, ShopifyBillingError } from '@/lib/shopify-billing';

const ok = (partnerDevelopment: boolean) => ({
  status: 200,
  data: { shop: { plan: { partnerDevelopment } } },
  errors: [],
  bodyText: '',
});

beforeEach(() => vi.clearAllMocks());

describe('isDevelopmentStore', () => {
  it('tienda de desarrollo → true (cargo de prueba), en una sola consulta', async () => {
    mocks.graphql.mockResolvedValue(ok(true));
    expect(await isDevelopmentStore('dev.myshopify.com', 'shpat')).toBe(true);
    expect(mocks.graphql).toHaveBeenCalledTimes(1);
  });

  it('tienda real → false (cargo real), en una sola consulta', async () => {
    mocks.graphql.mockResolvedValue(ok(false));
    expect(await isDevelopmentStore('real.myshopify.com', 'shpat')).toBe(false);
    expect(mocks.graphql).toHaveBeenCalledTimes(1);
  });

  it('🔴 un 429 la primera vez y 200 la segunda → se resuelve bien: el reintento salva la compra', async () => {
    mocks.graphql
      .mockResolvedValueOnce({ status: 429, data: null, errors: [], bodyText: 'throttled' })
      .mockResolvedValueOnce(ok(true));
    expect(await isDevelopmentStore('dev.myshopify.com', 'shpat')).toBe(true);
    expect(mocks.graphql).toHaveBeenCalledTimes(2);
  });

  it('🔴 dos fallos seguidos → ShopifyPlanUnresolvedError, NUNCA false (que sería cobrar de verdad a ciegas)', async () => {
    mocks.graphql.mockResolvedValue({ status: 502, data: null, errors: [], bodyText: '' });
    await expect(isDevelopmentStore('dev.myshopify.com', 'shpat')).rejects.toBeInstanceOf(ShopifyPlanUnresolvedError);
    expect(mocks.graphql).toHaveBeenCalledTimes(2);
  });

  it('200 con data nula (ACCESS_DENIED) tampoco se adivina', async () => {
    mocks.graphql.mockResolvedValue({
      status: 200,
      data: null,
      errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }],
      bodyText: '',
    });
    await expect(isDevelopmentStore('x.myshopify.com', 'shpat')).rejects.toThrow('No pudimos verificar tu tienda');
  });

  it('una excepción de red también reintenta y después tira, con el motivo en detail', async () => {
    mocks.graphql.mockRejectedValue(new Error('fetch failed'));
    const err = await isDevelopmentStore('x.myshopify.com', 'shpat').catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyPlanUnresolvedError);
    expect((err as ShopifyBillingError).detail).toContain('fetch failed');
    expect(mocks.graphql).toHaveBeenCalledTimes(2);
  });

  it('el error es un ShopifyBillingError: el checkout lo atrapa por el mismo camino que el resto', () => {
    expect(new ShopifyPlanUnresolvedError('x')).toBeInstanceOf(ShopifyBillingError);
  });
});
