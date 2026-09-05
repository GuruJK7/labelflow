import { describe, it, expect, vi } from 'vitest';
import { getUnfulfilledOrders, siguientePageInfo, PAGINA_REST } from '../shopify/orders';
import type { AxiosInstance } from 'axios';
import type { ShopifyOrder } from '../shopify/types';

/**
 * 🔴 EL BUG: `getUnfulfilledOrders` hacía UNA sola llamada REST con
 * `limit: 250` y devolvía lo que entrara. Una tienda con 400 pedidos sin
 * despachar veía 250 y las otras 150 no existían para el job — sin log, sin
 * contador, sin nada. Apretar "Todos" despachaba 250.
 *
 * Y REST es el camino real en producción: `resolveShopifyApi` devuelve 'rest'
 * para todo tenant que no venga del App Store (`shopify/mode.ts`).
 */

function pedido(id: number, extra: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id,
    name: `#${id}`,
    email: 't@e.com',
    total_price: '100',
    currency: 'UYU',
    tags: '',
    shipping_address: null,
    line_items: [],
    note: null,
    note_attributes: null,
    ...extra,
  } as ShopifyOrder;
}

/** Cliente que sirve páginas y expone qué params recibió en cada llamada. */
function clientePaginado(paginas: ShopifyOrder[][], base = 'https://x.myshopify.com/admin/api/2026-07/orders.json') {
  const llamadas: Array<Record<string, unknown>> = [];
  const get = vi.fn(async (_url: string, cfg?: { params?: Record<string, unknown> }) => {
    llamadas.push(cfg?.params ?? {});
    const i = llamadas.length - 1;
    const orders = paginas[i] ?? [];
    const hayMas = i < paginas.length - 1;
    return {
      data: { orders },
      headers: hayMas ? { link: `<${base}?limit=250&page_info=cursor${i + 1}>; rel="next"` } : {},
    };
  });
  return { client: { get } as unknown as AxiosInstance, llamadas, get };
}

describe('siguientePageInfo', () => {
  it('saca el page_info del rel="next"', () => {
    const link = '<https://x.myshopify.com/admin/api/2026-07/orders.json?limit=250&page_info=abc123>; rel="next"';
    expect(siguientePageInfo(link)).toBe('abc123');
  });

  it('elige el next aunque venga junto al previous', () => {
    const link =
      '<https://x/admin/orders.json?page_info=ANTERIOR>; rel="previous", <https://x/admin/orders.json?page_info=SIGUIENTE>; rel="next"';
    expect(siguientePageInfo(link)).toBe('SIGUIENTE');
  });

  it('sin next → null (fin de la paginación)', () => {
    expect(siguientePageInfo('<https://x/admin/orders.json?page_info=A>; rel="previous"')).toBeNull();
    expect(siguientePageInfo('')).toBeNull();
    expect(siguientePageInfo(undefined)).toBeNull();
    expect(siguientePageInfo(null)).toBeNull();
    expect(siguientePageInfo(42)).toBeNull();
  });

  it('una URL rota no tira la corrida', () => {
    expect(siguientePageInfo('<no-es-una-url>; rel="next"')).toBeNull();
  });
});

describe('getUnfulfilledOrders — paginación REST', () => {
  it('SIN tope explícito se comporta igual que siempre: una página de 250', async () => {
    const { client, llamadas } = clientePaginado([[pedido(1), pedido(2)]]);
    const r = await getUnfulfilledOrders(client);
    expect(r).toHaveLength(2);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].limit).toBe(PAGINA_REST);
    expect(llamadas[0].fulfillment_status).toBe('unfulfilled');
  });

  it('con tope alto sigue el header Link y junta TODAS las páginas', async () => {
    const p1 = Array.from({ length: 250 }, (_, i) => pedido(i + 1));
    const p2 = Array.from({ length: 150 }, (_, i) => pedido(i + 251));
    const { client, llamadas } = clientePaginado([p1, p2]);

    const r = await getUnfulfilledOrders(client, 'oldest_first', false, 1000);

    // Antes de este arreglo esto daba 250.
    expect(r).toHaveLength(400);
    expect(llamadas).toHaveLength(2);
  });

  it('la 2a página va SOLO con limit + page_info (Shopify rechaza los filtros ahí)', async () => {
    const p1 = Array.from({ length: 250 }, (_, i) => pedido(i + 1));
    const { client, llamadas } = clientePaginado([p1, [pedido(999)]]);

    await getUnfulfilledOrders(client, 'oldest_first', false, 1000);

    expect(llamadas[1]).toEqual({ limit: PAGINA_REST, page_info: 'cursor1' });
    expect(llamadas[1]).not.toHaveProperty('fulfillment_status');
    expect(llamadas[1]).not.toHaveProperty('status');
    expect(llamadas[1]).not.toHaveProperty('financial_status');
  });

  it('nunca devuelve más que el tope', async () => {
    const p1 = Array.from({ length: 250 }, (_, i) => pedido(i + 1));
    const p2 = Array.from({ length: 250 }, (_, i) => pedido(i + 251));
    const { client } = clientePaginado([p1, p2]);

    const r = await getUnfulfilledOrders(client, 'oldest_first', false, 300);
    expect(r).toHaveLength(300);
  });

  it('una página vacía corta el bucle (no gira infinito)', async () => {
    const { client, llamadas } = clientePaginado([[], [pedido(1)]]);
    const r = await getUnfulfilledOrders(client, 'oldest_first', false, 1000);
    expect(r).toHaveLength(0);
    expect(llamadas).toHaveLength(1);
  });

  it('sin header Link corta después de la primera página', async () => {
    const get = vi.fn().mockResolvedValue({ data: { orders: [pedido(1)] } }); // sin `headers`
    const client = { get } as unknown as AxiosInstance;
    const r = await getUnfulfilledOrders(client, 'oldest_first', false, 1000);
    expect(r).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('el filtro de contra entrega se aplica sobre TODAS las páginas, no sólo la primera', async () => {
    const p1 = Array.from({ length: 250 }, (_, i) => pedido(i + 1, { financial_status: 'paid' }));
    const p2 = [
      pedido(900, { financial_status: 'pending' }),
      pedido(901, { financial_status: 'refunded' }), // se descarta
      pedido(902, { financial_status: 'voided' }), // se descarta
    ];
    const { client } = clientePaginado([p1, p2]);

    const r = await getUnfulfilledOrders(client, 'oldest_first', true, 1000);

    expect(r).toHaveLength(251);
    expect(r.some((o) => o.id === 900)).toBe(true);
    expect(r.some((o) => o.id === 901)).toBe(false);
    expect(r.some((o) => o.id === 902)).toBe(false);
  });
});
