/**
 * AutoEnvía Dashboard source — adapter.
 *
 * Convierte un pedido del dashboard en el shape interno que el pipeline DAC ya
 * consume (ShopifyOrder + AddressOverride). Es PURO (sin I/O, sin Playwright)
 * para testear aislado. Mismo patrón que test-dac-10-shipments.ts, que también
 * arma órdenes a mano y las manda a createShipment().
 *
 * Aislamiento de dedup: el id de Shopify es numérico y la clave de dedup
 * (Label/PendingShipment) es (tenantId, String(order.id)). Derivamos un id
 * numérico ESTABLE del uuid del dashboard. Con un tenant DEDICADO (sin pedidos
 * Shopify) no hay colisión posible con ids reales de Shopify; entre uuids, 52
 * bits hacen la colisión inviable para el volumen de esta fuente.
 */
import { createHash } from 'crypto';
import type { ShopifyOrder } from '../shopify/types';
import type { AddressOverride } from '../dac/shipment';
import type { DashboardOrder } from './orders';

/** id numérico estable y único derivado del uuid. Usa los primeros 13 hex (52
 *  bits, < 2^53) de sha256(uuid COMPLETO): así la colisión depende de la
 *  difusión del hash, no de uuids que compartan prefijo. Esta clave alimenta
 *  el dedup (tenantId, String(id)) de Label/PendingShipment. */
export function stableNumericId(uuid: string): number {
  const hex = createHash('sha256').update(String(uuid)).digest('hex').slice(0, 13);
  const n = parseInt(hex, 16);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/**
 * DAC usa los departamentos SIN acento (ver VALID_DEPARTMENTS en
 * dac/ai-resolver.ts: 'San Jose', 'Rio Negro', 'Paysandu', 'Tacuarembo'). El
 * formulario del comprador los muestra CON acento; acá los convertimos a la
 * grafía EXACTA que DAC acepta, sino el dropdown K_Estado no matchea y la
 * dirección no carga. Los otros 15 ya coinciden tal cual.
 */
const DEPT_TO_DAC: Record<string, string> = {
  'Paysandú': 'Paysandu',
  'Río Negro': 'Rio Negro',
  'San José': 'San Jose',
  'Tacuarembó': 'Tacuarembo',
};
export function departmentForDac(dept: string): string {
  if (!dept) return dept;
  if (DEPT_TO_DAC[dept]) return DEPT_TO_DAC[dept];
  // Fallback defensivo: cualquier acento residual -> grafía sin acento.
  return dept.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export interface AdaptedOrder {
  order: ShopifyOrder;
  override: AddressOverride;
  dashboardId: string;
}

/** Mapea un pedido del dashboard a (ShopifyOrder, AddressOverride, dashboardId). */
export function toShopifyOrder(d: DashboardOrder): AdaptedOrder {
  const a = d.address!;
  const fullName = (a.full_name || '').trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || fullName || 'Cliente';
  const lastName = parts.slice(1).join(' ');

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const total = d.items.reduce((s, it) => s + num(it.price) * Math.max(1, it.qty || 1), 0);
  const dacDept = departmentForDac(a.department || ''); // grafía exacta que DAC acepta

  const order: ShopifyOrder = {
    id: stableNumericId(d.id),
    name: `AE-${(d.id || '').slice(0, 8)}`,
    email: a.email || '',
    total_price: total > 0 ? total.toFixed(2) : '0.00',
    currency: 'UYU',
    tags: '',
    phone: a.phone || null,
    shipping_address: {
      first_name: firstName,
      last_name: lastName,
      phone: a.phone || '',
      address1: a.address_line || a.street || '',
      address2: '',
      city: a.city || '',
      province: dacDept,
      zip: a.postal_code || '',
      country: 'Uruguay',
    },
    line_items: d.items.map((it) => ({
      title: it.name,
      quantity: Math.max(1, it.qty || 1),
      price: num(it.price).toFixed(2),
      product_id: null,
    })),
    note: d.dac_text ?? null,
    note_attributes: null,
  };

  // El override es el mecanismo para la dirección de TEXTO LIBRE: address1 lleva
  // el "dirección o agencia" tal cual (los guards de agencia/sin-número lo
  // manejan), department/phone/nombre se fijan explícitos. city solo si vino.
  const override: AddressOverride = {
    address1: a.address_line || undefined,
    department: dacDept || undefined,
    recipientName: fullName || undefined,
    phone: a.phone || undefined,
    ...(a.city ? { city: a.city } : {}),
    ...(a.reference ? { notes: a.reference } : {}),
  };

  return { order, override, dashboardId: d.id };
}
