import { describe, it, expect, vi } from 'vitest';
import { getUnfulfilledOrders } from '../shopify/orders';
import { UNFULFILLED_QUERY_STRING, UNFULFILLED_QUERY_STRING_CONTRAENTREGA } from '../shopify/orders-graphql';
import { pedidoDesdeOrden, yaEstaCobrado } from '../correo/adapter';
import type { AxiosInstance } from 'axios';
import type { ShopifyOrder } from '../shopify/types';
import type { LocalidadCorreo } from '../correo/types';

/**
 * Tiendas que COBRAN AL ENTREGAR.
 *
 * Shopify deja un pedido contra entrega en `financial_status: 'pending'`
 * (verificado el 04-09-2026 en el bot de Calmora: `crearOrdenShopifyContra-
 * rreembolso` manda `pagado: false` → `"pending"`). Con el filtro fijo en
 * `paid`, el pipeline no veía NI UNO de esos pedidos y la tienda quedaba con la
 * cola siempre vacía, sin ningún error que lo explicara.
 *
 * Los dos riesgos que aparecen al abrir el filtro, y que estos tests fijan:
 *  1. Despachar pedidos reembolsados o anulados (mercadería por una venta que
 *     ya no existe).
 *  2. Cobrarle en destino a alguien que YA pagó en el checkout — la misma
 *     tienda tiene las dos clases de pedido mezcladas.
 */
const orden = (o: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 1, name: '#1', email: 'a@b.com', total_price: '990', currency: 'UYU', tags: '',
  shipping_address: null, line_items: [], note: null, note_attributes: null, ...o,
} as ShopifyOrder);

const clienteQueDevuelve = (orders: ShopifyOrder[]) => {
  const get = vi.fn().mockResolvedValue({ data: { orders } });
  return { client: { get } as unknown as AxiosInstance, get };
};

describe('qué pedidos se le piden a Shopify', () => {
  it('por defecto (DAC de siempre) pide SÓLO los pagados', async () => {
    const { client, get } = clienteQueDevuelve([]);
    await getUnfulfilledOrders(client);
    expect(get.mock.calls[0][1].params.financial_status).toBe('paid');
  });

  it('con contra entrega pide `any`, porque REST no acepta dos estados', async () => {
    const { client, get } = clienteQueDevuelve([]);
    await getUnfulfilledOrders(client, 'oldest_first', true);
    expect(get.mock.calls[0][1].params.financial_status).toBe('any');
  });

  it('y descarta los reembolsados y anulados que `any` arrastra', async () => {
    const { client } = clienteQueDevuelve([
      orden({ id: 1, financial_status: 'paid' }),
      orden({ id: 2, financial_status: 'pending' }),
      orden({ id: 3, financial_status: 'refunded' }),
      orden({ id: 4, financial_status: 'voided' }),
      orden({ id: 5, financial_status: 'partially_refunded' }),
    ]);
    const r = await getUnfulfilledOrders(client, 'oldest_first', true);
    expect(r.map((o) => o.id)).toEqual([1, 2]);
  });

  it('el filtro de GraphQL suma pending sin soltar los cancelados', () => {
    expect(UNFULFILLED_QUERY_STRING).toBe('financial_status:paid status:open');
    expect(UNFULFILLED_QUERY_STRING_CONTRAENTREGA).toContain('financial_status:pending');
    expect(UNFULFILLED_QUERY_STRING_CONTRAENTREGA).toContain('financial_status:paid');
    expect(UNFULFILLED_QUERY_STRING_CONTRAENTREGA).not.toContain('refunded');
  });
});

describe('no cobrarle dos veces a quien ya pagó', () => {
  const CATALOGO: LocalidadCorreo[] = [
    { nombre: 'Salto', ciudad: 'Salto', departamento: 'Salto', direccion: 'Uruguay 1234',
      codigoPostal: '50000', codigoAHIVA: 1, siteCode: 'SAL', telefono: '4732' },
  ];
  const cfg = { pesoDefaultKg: 0.3, oficinaDevolucion: null, contraEntrega: true };
  const conDireccion = (f: string | null) => orden({
    financial_status: f,
    shipping_address: { first_name: 'Ana', last_name: 'P', phone: '099111222', address1: 'Uruguay 1',
      address2: '', city: 'Salto', province: 'Salto', zip: '50000', country: 'Uruguay' },
  } as Partial<ShopifyOrder>);

  it('reconoce los estados que ya tienen la plata cobrada', () => {
    expect(yaEstaCobrado(orden({ financial_status: 'paid' }))).toBe(true);
    expect(yaEstaCobrado(orden({ financial_status: 'partially_paid' }))).toBe(true);
    // `authorized` = plata autorizada online que el comerciante va a capturar.
    // Cobrarla también al entregar sería cobrarle dos veces al comprador.
    expect(yaEstaCobrado(orden({ financial_status: 'authorized' }))).toBe(true);
    expect(yaEstaCobrado(orden({ financial_status: 'pending' }))).toBe(false);
    // La fuente panel no manda el campo: sus pedidos son contra entrega.
    expect(yaEstaCobrado(orden({}))).toBe(false);
  });

  it('el pedido PENDING se despacha CON cobro en destino', () => {
    const r = pedidoDesdeOrden(conDireccion('pending'), CATALOGO, cfg as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pedido.codAmount).toBe(990);
  });

  it('el pedido YA PAGADO se despacha SIN cobro, no a revisión', () => {
    // Se despacha perfecto: lo único que cambia es que no se cobra de nuevo.
    const r = pedidoDesdeOrden(conDireccion('paid'), CATALOGO, cfg as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pedido.codAmount).toBeNull();
  });
});
