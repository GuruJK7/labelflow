// Requisito 2.2.4 del App Store: una app pública nueva no puede consultar
// recursos REST de productos. Esta ruta ERA el caso prohibido (products.json)
// y ahora sale por la Admin API GraphQL. Lo que estos tests cuidan:
//
//   1. Que no quede NI UNA llamada a REST.
//   2. 🔴 Que las claves del mapa sigan siendo el ID NUMÉRICO y no el GID: el
//      worker resuelve `cache[String(item.product_id)]`, así que un GID rompe
//      el filtro de productos de todos los tenants con whitelist, en silencio.
//   3. Que el shape de la respuesta que consume el dashboard no se mueva.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantUpdate: vi.fn(),
  shopifyAccessForTenant: vi.fn(),
}));

vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: { tenant: { findUnique: mocks.tenantFindUnique, update: mocks.tenantUpdate } },
}));
vi.mock('@/lib/shopify-access', () => ({
  shopifyAccessForTenant: mocks.shopifyAccessForTenant,
}));

import { POST } from '@/app/api/v1/products/scan/route';

const fetchSpy = vi.fn();

/** Respuesta cruda de graphql.json (200 aunque traiga `errors`). */
function gql(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function productsPage(
  nodes: Array<{ legacyResourceId: string; title: string; productType: string; vendor: string }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
) {
  return gql({ data: { products: { pageInfo, nodes } } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: true, subscriptionStatus: 'ACTIVE',
  });
  mocks.tenantFindUnique.mockResolvedValue({
    id: 'tenant-1', shopifyStoreUrl: 'mitienda.myshopify.com', shopifyToken: 'enc',
  });
  mocks.tenantUpdate.mockResolvedValue({});
  mocks.shopifyAccessForTenant.mockResolvedValue('shpat_token');
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/v1/products/scan — 2.2.4: sólo GraphQL', () => {
  it('no toca REST y pide la query de productos a graphql.json', async () => {
    fetchSpy.mockResolvedValue(
      productsPage([
        { legacyResourceId: '123', title: 'Curvadivina', productType: 'Cremas', vendor: 'Aktiva' },
      ]),
    );

    const res = await POST();
    expect(res.status).toBe(200);

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://mitienda.myshopify.com/admin/api/2026-07/graphql.json');
    // Ni products.json ni ningún otro recurso REST.
    expect(urls.some((u) => u.includes('.json?') || u.endsWith('/products.json'))).toBe(false);

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(body.query).toContain('products(first: $first, after: $after)');
    expect(body.query).toContain('legacyResourceId');
    expect(body.variables.first).toBe(250); // mismo tope que el limit=250 de REST
  });

  it('🔴 guarda el ID NUMÉRICO como clave, no el GID', async () => {
    fetchSpy.mockResolvedValue(
      productsPage([
        { legacyResourceId: '7891011', title: 'Serum', productType: 'Cremas', vendor: 'Aktiva' },
      ]),
    );

    await POST();

    const saved = mocks.tenantUpdate.mock.calls[0][0].data.productTypeCache as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(['7891011']);
    expect(Object.keys(saved).some((k) => k.startsWith('gid://'))).toBe(false);
    expect(saved['7891011']).toEqual({ title: 'Serum', type: 'Cremas', vendor: 'Aktiva' });
  });

  it('mantiene el shape que consume el dashboard', async () => {
    fetchSpy.mockResolvedValue(
      productsPage([
        { legacyResourceId: '2', title: 'Zapato', productType: 'Calzado', vendor: 'Nordika' },
        { legacyResourceId: '1', title: 'Aceite', productType: '', vendor: 'Aktiva' },
      ]),
    );

    const res = await POST();
    const json = await res.json();

    expect(json.data.products).toEqual([
      { id: '1', title: 'Aceite', type: '', vendor: 'Aktiva' },
      { id: '2', title: 'Zapato', type: 'Calzado', vendor: 'Nordika' },
    ]);
    expect(json.data.productTypes).toEqual(['Calzado']);
    expect(json.data.vendors).toEqual(['Aktiva', 'Nordika']);
    expect(json.data.totalProducts).toBe(2);
    expect(json.data.source).toBe('products');
    expect(typeof json.data.scannedAt).toBe('string');
  });

  it('pagina con cursor hasta que hasNextPage es false', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        productsPage(
          [{ legacyResourceId: '1', title: 'A', productType: 'T', vendor: 'V' }],
          { hasNextPage: true, endCursor: 'cursor-1' },
        ),
      )
      .mockResolvedValueOnce(
        productsPage([{ legacyResourceId: '2', title: 'B', productType: 'T', vendor: 'V' }]),
      );

    const res = await POST();
    const json = await res.json();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1].body)).variables.after).toBe(null);
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1].body)).variables.after).toBe('cursor-1');
    expect(json.data.totalProducts).toBe(2);
  });

  it('ACCESS_DENIED viene con HTTP 200: igual cae al fallback de pedidos', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        gql({ data: null, errors: [{ message: 'Access denied for products field', extensions: { code: 'ACCESS_DENIED' } }] }),
      )
      .mockResolvedValueOnce(
        gql({
          data: {
            orders: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { lineItems: { nodes: [
                  { title: 'Kit', vendor: 'Aura', product: { legacyResourceId: '55' } },
                  { title: 'Sin producto', vendor: 'Aura', product: null },
                ] } },
              ],
            },
          },
        }),
      );

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.source).toBe('orders');
    expect(json.data.products).toEqual([{ id: '55', title: 'Kit', type: '', vendor: 'Aura' }]);
    const body = JSON.parse(String(fetchSpy.mock.calls[1][1].body));
    expect(body.query).toContain('orders(first: $first');
    expect(body.query).not.toContain('status:any'); // sin `query` = todos los estados
  });

  it('tienda vacía por los dos caminos → 404 con el mensaje de siempre', async () => {
    fetchSpy
      .mockResolvedValueOnce(productsPage([]))
      .mockResolvedValueOnce(gql({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }));

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe(
      'No se encontraron productos en Shopify. Verifica que tu tienda tenga productos publicados.',
    );
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('401 de Shopify no explota: cae al fallback y termina en 404', async () => {
    fetchSpy
      .mockResolvedValueOnce(gql({ errors: '[API] Invalid API key or access token' }, 401))
      .mockResolvedValueOnce(gql({ errors: '[API] Invalid API key or access token' }, 401));

    const res = await POST();
    expect(res.status).toBe(404);
  });
});
