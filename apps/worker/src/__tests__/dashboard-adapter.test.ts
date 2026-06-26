/**
 * Unit tests for the AutoEnvía Dashboard adapter (toShopifyOrder / stableNumericId).
 * Pure functions — no Playwright, no DB, no network.
 */
import { describe, it, expect } from 'vitest';
import { toShopifyOrder, stableNumericId, departmentForDac } from '../dashboard/adapter';
import type { DashboardOrder } from '../dashboard/orders';

function mk(overrides: Partial<DashboardOrder> = {}): DashboardOrder {
  return {
    id: '2222829d-622b-4ce3-ab07-8e46a15e9030',
    status: 'confirmed',
    seller: { name: 'Santi', slug: 'santi' },
    buyer_name: 'Carla',
    items: [{ name: 'Perfume árabe Oud', qty: 2, price: 1500 }],
    address: {
      full_name: 'Carla Pérez',
      phone: '099887766',
      department: 'Maldonado',
      address_line: 'Agencia DAC Maldonado centro, retiro por mostrador',
      city: null,
      neighborhood: null,
      street: null,
      number: null,
      postal_code: null,
      reference: null,
      document: null,
      email: null,
    },
    dac_text: 'Nombre: Carla Pérez\nTeléfono: 099887766',
    ...overrides,
  };
}

describe('stableNumericId', () => {
  it('is deterministic, positive and a safe integer', () => {
    const a = stableNumericId('2222829d-622b-4ce3-ab07-8e46a15e9030');
    const b = stableNumericId('2222829d-622b-4ce3-ab07-8e46a15e9030');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(Number.isSafeInteger(a)).toBe(true);
  });
  it('maps different uuids to different ids', () => {
    expect(stableNumericId('aaaaaaaa-0000-0000-0000-000000000000'))
      .not.toBe(stableNumericId('bbbbbbbb-0000-0000-0000-000000000000'));
  });
  it('never throws on garbage input', () => {
    expect(stableNumericId('')).toBeGreaterThan(0);
    expect(stableNumericId('zzzz')).toBeGreaterThan(0);
  });
});

describe('departmentForDac', () => {
  it('maps the 4 accented departments to DAC accent-free spelling', () => {
    expect(departmentForDac('Paysandú')).toBe('Paysandu');
    expect(departmentForDac('Río Negro')).toBe('Rio Negro');
    expect(departmentForDac('San José')).toBe('San Jose');
    expect(departmentForDac('Tacuarembó')).toBe('Tacuarembo');
  });
  it('passes through the 15 departments that already match DAC', () => {
    for (const d of ['Montevideo', 'Canelones', 'Maldonado', 'Rocha', 'Colonia', 'Florida', 'Durazno', 'Flores', 'Lavalleja', 'Treinta y Tres', 'Cerro Largo', 'Rivera', 'Artigas', 'Salto', 'Soriano']) {
      expect(departmentForDac(d)).toBe(d);
    }
  });
});

describe('toShopifyOrder', () => {
  it('normalizes the department to DAC spelling in province AND override', () => {
    const d = mk();
    d.address!.department = 'Paysandú';
    const { order, override } = toShopifyOrder(d);
    expect(order.shipping_address?.province).toBe('Paysandu');
    expect(override.department).toBe('Paysandu');
  });

  it('namespaces the id from the uuid and names AE-<first8>', () => {
    const { order, dashboardId } = toShopifyOrder(mk());
    expect(order.id).toBe(stableNumericId('2222829d-622b-4ce3-ab07-8e46a15e9030'));
    expect(order.name).toBe('AE-2222829d');
    expect(dashboardId).toBe('2222829d-622b-4ce3-ab07-8e46a15e9030');
  });

  it('splits full_name into first/last and sets recipientName override', () => {
    const { order, override } = toShopifyOrder(mk());
    expect(order.shipping_address?.first_name).toBe('Carla');
    expect(order.shipping_address?.last_name).toBe('Pérez');
    expect(override.recipientName).toBe('Carla Pérez');
  });

  it('sums total_price = price*qty over items', () => {
    const { order } = toShopifyOrder(mk({ items: [{ name: 'a', qty: 2, price: 1500 }, { name: 'b', qty: 1, price: 500 }] }));
    expect(order.total_price).toBe('3500.00');
  });

  it('maps address_line/department/phone into shipping_address AND override', () => {
    const { order, override } = toShopifyOrder(mk());
    expect(order.shipping_address?.address1).toBe('Agencia DAC Maldonado centro, retiro por mostrador');
    expect(order.shipping_address?.province).toBe('Maldonado');
    expect(order.shipping_address?.phone).toBe('099887766');
    expect(override.address1).toBe('Agencia DAC Maldonado centro, retiro por mostrador');
    expect(override.department).toBe('Maldonado');
    expect(override.phone).toBe('099887766');
  });

  it('leaves city/zip empty when not provided (free-text form) and city override absent', () => {
    const { order, override } = toShopifyOrder(mk());
    expect(order.shipping_address?.city).toBe('');
    expect(order.shipping_address?.zip).toBe('');
    expect(override.city).toBeUndefined();
  });

  it('passes city override and reference notes when present', () => {
    const d = mk();
    d.address!.city = 'Pocitos';
    d.address!.reference = 'Casa azul, portón';
    const { override } = toShopifyOrder(d);
    expect(override.city).toBe('Pocitos');
    expect(override.notes).toBe('Casa azul, portón');
  });

  it('handles zero/negative/missing prices as 0 and qty<1 as 1', () => {
    const { order } = toShopifyOrder(mk({ items: [
      { name: 'zero', qty: 1, price: 0 },
      { name: 'neg', qty: 1, price: -5 },
      { name: 'missing', qty: 0, price: null },
    ] }));
    // -5 contributes -5; 0 and null contribute 0 → total -5 → not > 0 → "0.00"
    expect(order.total_price).toBe('0.00');
    expect(order.line_items[2].quantity).toBe(1); // qty 0 floored to 1
    expect(order.line_items.every((li) => /^-?\d+\.\d{2}$/.test(li.price))).toBe(true);
  });

  it('falls back to "Cliente" when full_name is empty', () => {
    const d = mk();
    d.address!.full_name = '';
    const { order } = toShopifyOrder(d);
    expect(order.shipping_address?.first_name).toBe('Cliente');
  });
});
