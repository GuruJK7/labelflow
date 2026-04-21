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

/**
 * H-4 (2026-04-21 audit): the old substring-based APT detector produced
 * false positives on several common UY address patterns — "Rivera 2345
 * bis", "Av. Brasil Ter", "Dr. P. Russo 5678", "Torres de Carrasco 1500".
 * The strict regex form below uses word-boundary anchors so "aptos" and
 * "torres" (plural forms that are NOT apt markers) don't trigger. Number-
 * modifier suffixes "bis" and "ter" were removed entirely — they are part
 * of the door number, not apartment info. The honorific abbreviation
 * "p." was dropped because it collides with "Dr. P." style names. The
 * word "casa" (house) was also dropped — it's the OPPOSITE of apartment
 * info; a value like "Casa portones blancos" in address2 is a landmark
 * description that the courier should see in observaciones, so it should
 * correctly trigger ADDRESS2_PRESENT (not be suppressed as a fake apt).
 *
 * Coverage matrix:
 *   apto 5 / Apto 5 / apto5 / APTO5  → matches (lookahead: \b or digit)
 *   aptos / apartamentos             → NO match (plural, no word boundary)
 *   1er piso, / piso 3 / piso:4      → matches via \bpiso\b
 *   pisotearon                       → NO match (no \b after piso)
 *   Torre 2 Apto 5                   → matches (\btorre\b + \s*\d)
 *   Torres de Carrasco 1500          → NO match (plural, \b breaks)
 *   Block A2                         → matches (\bblock\b + \s*\d)
 *   Casa portones blancos            → NO match (casa is landmark, not apt)
 */
const APT_MARKER_PATTERNS: RegExp[] = [
  // apto/apt/apartamento/depto/dpto/departamento — standalone word OR immediately
  // followed by a digit (handles "apto5" without space).
  /\b(apto|apt|apartamento|depto|dpto|departamento)(?=\b|\d)/i,
  // piso/planta — standalone word. Catches "1er piso" and "piso 3" alike. Does
  // not require a following digit because "piso" as a bare word is signal enough.
  /\b(piso|planta)\b/i,
  // torre/block/blq — standalone word followed by whitespace and a digit.
  // "Torres de Carrasco" does not match (plural has no word boundary after "torre").
  /\b(torre|block|blq)\b\s*\d/i,
];

const URUGUAY_COUNTRIES = new Set(['uruguay', 'uy', 'ury', '']);

function hasAptMarker(address: string): boolean {
  return APT_MARKER_PATTERNS.some((rx) => rx.test(address));
}

/**
 * H-3 (2026-04-21 audit): the old permissive "7–13 digits" check silently
 * accepted anything vaguely phone-shaped, including random 7-digit strings
 * and misformatted numbers. DAC accepts the call but couriers get bounce-
 * backs for numbers that don't reach UY carriers.
 *
 * Uruguayan numbering plan (ANTEL/MOV):
 *   Móvil (cell)     — 8 digits starting with 9, commonly written as
 *                      "09X XXX XXX" (9-digit local with leading 0).
 *   Fijo Montevideo  — 8 digits starting with 2.
 *   Fijo interior    — 8 digits starting with 4.
 *   Country code     — 598 (may appear as "+598", "598", or "00598").
 *                      Stripping the prefix yields the 8- or 9-digit local
 *                      form above.
 *
 * Anything else (7-digit, 10-digit random, numbers starting with 3/5/6/7/8,
 * toll-free 0800, 3-digit emergency services) is flagged WEIRD_PHONE — the
 * order is still shippable (we fall back to "00000000") but someone should
 * double-check before the courier is dispatched.
 */
const UY_MOVIL_LOCAL_RX = /^0?9\d{7}$/;         // 9XXXXXXX or 09XXXXXXX
const UY_FIJO_LOCAL_RX = /^[24]\d{7}$/;         // 2XXXXXXX or 4XXXXXXX

function looksLikeUyPhone(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return false;

  // Strip UY country-code prefixes before validating the local form.
  if (digits.startsWith('00598')) digits = digits.slice(5);
  else if (digits.startsWith('598')) digits = digits.slice(3);

  return UY_MOVIL_LOCAL_RX.test(digits) || UY_FIJO_LOCAL_RX.test(digits);
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
