/**
 * Order classifier — GREEN / YELLOW / RED zones.
 *
 * Before the agent picks up a job, Render classifies each order by how
 * confidently the deterministic pipeline can produce a valid DAC shipment:
 *
 *   GREEN  — every required field is present, city resolves deterministically
 *            → agent runs normal Playwright flow, no Claude intelligence needed
 *   YELLOW — missing or ambiguous non-critical data: city not in geo map,
 *            apartment/floor mixed into address1, phone likely off-format, etc.
 *            → agent can try Playwright; Phase 2 will escalate to Claude skill
 *   RED    — missing CRITICAL data (no address, no city, no country, non-UY)
 *            → cannot ship; Label immediately marked NEEDS_REVIEW
 *
 * This module is pure and synchronous — it does not hit DB or network. It uses
 * the already-loaded `uruguay-geo` data. Keep it side-effect free so it stays
 * easy to unit-test.
 */
import type { ShopifyOrder } from '../shopify/types';
import { getDepartmentForCity } from '../dac/uruguay-geo';

export type OrderZone = 'GREEN' | 'YELLOW' | 'RED';

export interface ClassifiedOrder {
  orderId: string;
  orderName: string;
  zone: OrderZone;
  /** Short machine-readable codes — e.g. "NO_ADDRESS1", "UNKNOWN_CITY" */
  reasons: string[];
  /** Human-readable one-liner for logs / tenant emails */
  summary: string;
}

const APT_MARKERS = [
  'apto', 'apt.', 'apt ', 'apartamento',
  'piso ', 'p.', 'p ', 'planta ',
  ' bis', ' ter',
  'torre ', 'block ', 'blq',
  'casa ', 'cs ',
];

const URUGUAY_COUNTRIES = new Set(['uruguay', 'uy', 'ury', '']);

function hasAptMarker(address: string): boolean {
  const lower = address.toLowerCase();
  return APT_MARKERS.some((m) => lower.includes(m));
}

function looksLikeUyPhone(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const digits = raw.replace(/\D/g, '');
  // UY phones are 8–9 local digits (cell typically 9 digits starting 09).
  // With country code +598 it becomes 11–12 digits.
  return digits.length >= 7 && digits.length <= 13;
}

/**
 * Classify a single Shopify order.
 */
export function classifyOrder(order: ShopifyOrder): ClassifiedOrder {
  const reasons: string[] = [];
  const orderId = String(order.id);
  const orderName = order.name ?? `#${orderId}`;

  const addr = order.shipping_address;

  // ----- RED: impossible to ship -----
  if (!addr) {
    return {
      orderId,
      orderName,
      zone: 'RED',
      reasons: ['NO_SHIPPING_ADDRESS'],
      summary: 'Order has no shipping address.',
    };
  }

  if (!addr.address1 || addr.address1.trim().length < 3) {
    reasons.push('NO_ADDRESS1');
  }
  if (!addr.city || addr.city.trim().length === 0) {
    reasons.push('NO_CITY');
  }
  const countryLower = (addr.country ?? '').trim().toLowerCase();
  if (countryLower && !URUGUAY_COUNTRIES.has(countryLower)) {
    reasons.push('NON_UY_COUNTRY');
  }

  if (reasons.length > 0) {
    return {
      orderId,
      orderName,
      zone: 'RED',
      reasons,
      summary: `Critical data missing: ${reasons.join(', ')}`,
    };
  }

  // ----- YELLOW: shippable but ambiguous -----
  const warnings: string[] = [];

  // City not in our Uruguay geo map → will need intelligent fallback
  const deptFromCity = getDepartmentForCity(addr.city);
  if (!deptFromCity) {
    warnings.push('UNKNOWN_CITY');
  }

  // Missing/weird phone — DAC requires a phone, but we'll fill '00000000' as fallback
  if (!looksLikeUyPhone(addr.phone)) {
    warnings.push('WEIRD_PHONE');
  }

  // Apt/floor/piso mixed into address1 — DAC prefers it in observaciones
  if (hasAptMarker(addr.address1)) {
    warnings.push('APT_IN_ADDRESS1');
  }
  if (addr.address2 && addr.address2.trim().length > 0 && !hasAptMarker(addr.address2)) {
    // address2 present but not a typical apt marker — might be a reference,
    // still safe but flag for observation
    warnings.push('ADDRESS2_PRESENT');
  }

  // Province not set or doesn't match deptFromCity — ambiguous department
  if (deptFromCity && addr.province) {
    const a = deptFromCity.toLowerCase().trim();
    const b = addr.province.toLowerCase().trim();
    if (a !== b && !a.includes(b) && !b.includes(a)) {
      warnings.push('DEPT_MISMATCH');
    }
  }

  if (warnings.length > 0) {
    return {
      orderId,
      orderName,
      zone: 'YELLOW',
      reasons: warnings,
      summary: `Ambiguous but shippable: ${warnings.join(', ')}`,
    };
  }

  // ----- GREEN: clean -----
  return {
    orderId,
    orderName,
    zone: 'GREEN',
    reasons: [],
    summary: 'All fields present and deterministic.',
  };
}

export interface ClassificationSummary {
  green: ClassifiedOrder[];
  yellow: ClassifiedOrder[];
  red: ClassifiedOrder[];
  total: number;
}

/**
 * Classify a batch and return grouped results.
 */
export function classifyOrders(orders: ShopifyOrder[]): ClassificationSummary {
  const green: ClassifiedOrder[] = [];
  const yellow: ClassifiedOrder[] = [];
  const red: ClassifiedOrder[] = [];

  for (const order of orders) {
    const c = classifyOrder(order);
    if (c.zone === 'GREEN') green.push(c);
    else if (c.zone === 'YELLOW') yellow.push(c);
    else red.push(c);
  }

  return { green, yellow, red, total: orders.length };
}
