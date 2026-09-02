// D27: el adaptador GraphQL → REST tiene que producir EXACTAMENTE la forma que
// consumen dac/shipment.ts (intocable), las reglas y los jobs. Cada campo del
// inventario se afirma acá con un fixture realista de la Admin API 2026-07.
import { describe, it, expect } from 'vitest';
import {
  toRestOrder,
  toRestShippingAddress,
  mapDisplayFulfillmentStatus,
  mapFulfillmentOrderStatus,
  orderGid,
  legacyIdFromGid,
  type GqlOrderNode,
} from '../shopify/graphql-adapter';
import { resolveOrderPhone } from '../shopify/phone';

export const ORDER_NODE_FIXTURE: GqlOrderNode = {
  id: 'gid://shopify/Order/6001234567890',
  legacyResourceId: '6001234567890',
  name: '#1234',
  email: 'Ana@Example.com',
  phone: '+59899000111',
  note: 'Dejar en portería',
  tags: ['prioridad', 'RASTREO ENVIADO'],
  createdAt: '2026-09-01T12:00:00Z',
  currencyCode: 'UYU',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  totalPriceSet: { shopMoney: { amount: '2490.00', currencyCode: 'UYU' } },
  customAttributes: [
    { key: 'Observaciones', value: 'Llamar antes' },
    { key: 'Sin valor', value: null },
  ],
  shippingAddress: {
    firstName: 'Ana',
    lastName: 'Pérez',
    phone: '099111222',
    address1: 'Av. Italia 1234',
    address2: 'Apto 3',
    city: 'Montevideo',
    province: 'Montevideo',
    provinceCode: 'MO',
    zip: '11400',
    country: 'Uruguay',
    countryCodeV2: 'UY',
  },
  billingAddress: { phone: '098333444' },
  lineItems: {
    pageInfo: { hasNextPage: false, endCursor: 'c1' },
    nodes: [
      {
        id: 'gid://shopify/LineItem/1',
        title: 'Remera básica',
        variantTitle: 'M / Negro',
        quantity: 2,
        sku: 'REM-M-NEG',
        product: { legacyResourceId: '8001' },
        originalUnitPriceSet: { shopMoney: { amount: '990.00' } },
      },
      {
        id: 'gid://shopify/LineItem/2',
        title: 'Producto borrado',
        variantTitle: null,
        quantity: 1,
        sku: null,
        product: null,
        originalUnitPriceSet: { shopMoney: { amount: '510.00' } },
      },
    ],
  },
};

describe('toRestOrder — forma REST byte-compatible con types.ts', () => {
  const order = toRestOrder(ORDER_NODE_FIXTURE);

  it('id numérico = legacyResourceId (mismo número que Label.shopifyOrderId)', () => {
    expect(order.id).toBe(6001234567890);
    expect(typeof order.id).toBe('number');
    expect(String(order.id)).toBe('6001234567890');
    expect(order.admin_graphql_api_id).toBe('gid://shopify/Order/6001234567890');
  });

  it('name, email, phone, currency, total_price', () => {
    expect(order.name).toBe('#1234');
    expect(order.email).toBe('Ana@Example.com');
    expect(order.phone).toBe('+59899000111');
    expect(order.currency).toBe('UYU');
    expect(order.total_price).toBe('2490.00');
    expect(parseFloat(order.total_price)).toBe(2490);
  });

  it('tags como CSV (los consumidores hacen split(","))', () => {
    expect(order.tags).toBe('prioridad, RASTREO ENVIADO');
    expect(order.tags.split(',').map((t) => t.trim().toLowerCase())).toContain('rastreo enviado');
  });

  it('fulfillment_status / financial_status mapeados como REST', () => {
    expect(order.fulfillment_status).toBeNull();
    expect(order.financial_status).toBe('paid');
    expect(order.created_at).toBe('2026-09-01T12:00:00Z');
  });

  it('note y note_attributes (key → name; value null → "")', () => {
    expect(order.note).toBe('Dejar en portería');
    expect(order.note_attributes).toEqual([
      { name: 'Observaciones', value: 'Llamar antes' },
      { name: 'Sin valor', value: '' },
    ]);
  });

  it('shipping_address con los 9 campos de types.ts como string', () => {
    expect(order.shipping_address).toMatchObject({
      first_name: 'Ana',
      last_name: 'Pérez',
      phone: '099111222',
      address1: 'Av. Italia 1234',
      address2: 'Apto 3',
      city: 'Montevideo',
      province: 'Montevideo',
      zip: '11400',
      country: 'Uruguay',
    });
    expect((order.shipping_address as { province_code?: string }).province_code).toBe('MO');
    expect((order.shipping_address as { country_code?: string }).country_code).toBe('UY');
  });

  it('billing_address.phone y customer null (sin read_customers)', () => {
    expect(order.billing_address).toEqual({ phone: '098333444' });
    expect(order.customer).toBeNull();
  });

  it('line_items: title, quantity, sku, product_id (null si el producto se borró), price', () => {
    expect(order.line_items).toEqual([
      { title: 'Remera básica', quantity: 2, price: '990.00', product_id: 8001, sku: 'REM-M-NEG', variant_title: 'M / Negro' },
      { title: 'Producto borrado', quantity: 1, price: '510.00', product_id: null, sku: null, variant_title: null },
    ]);
  });

  it('agrega los line_items paginados al final', () => {
    const o = toRestOrder(ORDER_NODE_FIXTURE, [
      { id: 'gid://shopify/LineItem/3', title: 'Extra', quantity: 1, sku: 'X', product: { legacyResourceId: '9' } },
    ]);
    expect(o.line_items).toHaveLength(3);
    expect(o.line_items[2]).toMatchObject({ title: 'Extra', product_id: 9, price: '0.00' });
  });

  it('resolveOrderPhone sigue funcionando con la forma adaptada (prioridad shipping)', () => {
    expect(resolveOrderPhone(order)).toBe('099111222');
    const sinShipping = toRestOrder({ ...ORDER_NODE_FIXTURE, shippingAddress: null });
    expect(sinShipping.shipping_address).toBeNull();
    expect(resolveOrderPhone(sinShipping)).toBe('098333444');
  });
});

describe('nulls de GraphQL → defaults de types.ts', () => {
  it('pedido con casi todo en null no produce undefined en campos declarados string', () => {
    const o = toRestOrder({
      id: 'gid://shopify/Order/1',
      legacyResourceId: '1',
      name: '#1',
      email: null,
      phone: null,
      note: null,
      tags: [],
      customAttributes: null,
      shippingAddress: null,
      billingAddress: null,
      lineItems: null,
      totalPriceSet: null,
      displayFulfillmentStatus: null,
      displayFinancialStatus: null,
    });
    expect(o).toMatchObject({
      id: 1,
      email: '',
      phone: null,
      total_price: '0.00',
      currency: 'UYU',
      tags: '',
      note: null,
      note_attributes: [],
      shipping_address: null,
      billing_address: null,
      customer: null,
      line_items: [],
      fulfillment_status: null,
      financial_status: null,
    });
  });

  it('shipping_address con campos null → strings vacíos', () => {
    expect(toRestShippingAddress({ city: 'Salto' })).toMatchObject({
      first_name: '', last_name: '', phone: '', address1: '', address2: '', city: 'Salto', province: '', zip: '', country: '',
    });
  });
});

describe('mapeos de enums', () => {
  it('displayFulfillmentStatus → fulfillment_status REST', () => {
    expect(mapDisplayFulfillmentStatus('FULFILLED')).toBe('fulfilled');
    expect(mapDisplayFulfillmentStatus('PARTIALLY_FULFILLED')).toBe('partial');
    expect(mapDisplayFulfillmentStatus('RESTOCKED')).toBe('restocked');
    for (const s of ['UNFULFILLED', 'OPEN', 'IN_PROGRESS', 'ON_HOLD', 'SCHEDULED', 'PENDING_FULFILLMENT', 'REQUEST_DECLINED', null, undefined]) {
      expect(mapDisplayFulfillmentStatus(s)).toBeNull();
    }
  });

  it('FulfillmentOrderStatus → strings que ya compara fulfillment.ts', () => {
    expect(['OPEN', 'IN_PROGRESS', 'ON_HOLD', 'SCHEDULED', 'INCOMPLETE', 'CLOSED', 'CANCELLED'].map(mapFulfillmentOrderStatus))
      .toEqual(['open', 'in_progress', 'on_hold', 'scheduled', 'incomplete', 'closed', 'cancelled']);
  });

  it('GIDs', () => {
    expect(orderGid(123)).toBe('gid://shopify/Order/123');
    expect(legacyIdFromGid('gid://shopify/FulfillmentOrder/456')).toBe(456);
    expect(Number.isNaN(legacyIdFromGid('nope'))).toBe(true);
  });
});
