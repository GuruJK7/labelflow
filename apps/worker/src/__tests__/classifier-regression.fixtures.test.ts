/**
 * Regression fixture snapshot for order-classifier.
 *
 * Purpose: capture current bucket assignments (GREEN/YELLOW/RED) and the
 * output of the two predicates `hasAptMarker` and `looksLikeUyPhone` on
 * 40 addresses (20 real from Aura's Shopify + 20 synthetic covering the
 * tricky cases flagged by the 2026-04-21 audit).
 *
 * The expected values below were captured via a dump script against the
 * code BEFORE H-3 and H-4 landed (baseline 2026-04-21). After applying
 * the fixes, re-run this suite:
 *
 *   pnpm vitest run classifier-regression.fixtures
 *
 * Any failure is an INTENDED bucket change — see the `change` field on
 * each fixture for why it is expected to move (or "none" if the fix
 * must not touch it).
 *
 * DO NOT delete this file after Fase 1 lands. It stays as permanent
 * regression coverage against future classifier drift.
 */

import { describe, it, expect } from 'vitest';
import { classifyOrder } from '../rules/order-classifier';
import type { ShopifyOrder } from '../shopify/types';

// Build a minimal ShopifyOrder shell from fixture fields.
function order(
  i: number,
  overrides: Partial<{ address1: string; address2: string | null; city: string; province: string; country: string; phone: string | null }>,
): ShopifyOrder {
  return {
    id: 100_000 + i,
    name: `#F${i}`,
    email: 'test@example.com',
    total_price: '1000.00',
    currency: 'UYU',
    financial_status: 'paid',
    fulfillment_status: null,
    created_at: '2026-04-21T00:00:00Z',
    updated_at: '2026-04-21T00:00:00Z',
    line_items: [],
    shipping_address: {
      first_name: 'Fixture',
      last_name: 'User',
      address1: overrides.address1 ?? 'Default 100',
      address2: overrides.address2 ?? null,
      city: overrides.city ?? 'Montevideo',
      province: overrides.province ?? 'Montevideo',
      country: overrides.country ?? 'Uruguay',
      zip: '11300',
      phone: overrides.phone === null ? null : (overrides.phone ?? '099123456'),
    } as any,
  } as unknown as ShopifyOrder;
}

interface Fixture {
  tag: string;
  input: ShopifyOrder;
  /** BASELINE bucket (pre-H-3/H-4). */
  baselineZone: 'GREEN' | 'YELLOW' | 'RED';
  /** BASELINE reasons sorted alphabetically. */
  baselineReasons: string[];
  /**
   * Which fix (if any) will intentionally change the bucket. 'none' = must
   * stay identical post-fix. Update `postFixZone`/`postFixReasons` to the
   * new expected values when you reconcile after the fix lands.
   */
  change: 'none' | 'H-3' | 'H-4' | 'H-5';
  /** If change !== 'none', what the bucket should be AFTER the fix. */
  postFixZone?: 'GREEN' | 'YELLOW' | 'RED';
  postFixReasons?: string[];
  note?: string;
}

const FIXTURES: Fixture[] = [
  // ── REAL ORDERS (last 20 Aura) ───────────────────────────────────────
  { tag: 'real-1146', input: order(1, { address1: 'Doctor Andrés Puyol 1687', city: 'Montevideo' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none' },
  { tag: 'real-1145', input: order(2, { address1: 'Emilio de Franco m34 s17A entre Becú y Río de Janeiro', address2: 'Casa sin rejas', city: 'Lagomar' }),
    baselineZone: 'YELLOW', baselineReasons: ['DEPT_MISMATCH'], change: 'H-4',
    postFixZone: 'YELLOW', postFixReasons: ['ADDRESS2_PRESENT', 'DEPT_MISMATCH'],
    note: 'H-4: "Casa sin rejas" is a landmark/description, NOT apt info. Old substring matcher swallowed it; strict regex correctly surfaces ADDRESS2_PRESENT so courier sees the reference in observaciones.' },
  { tag: 'real-1144', input: order(3, { address1: 'Pedro Cea y Argentina', address2: 'Casa rejas grises pegado a pizeria "La barra"', city: 'La Floresta' }),
    baselineZone: 'YELLOW', baselineReasons: ['DEPT_MISMATCH'], change: 'H-4',
    postFixZone: 'YELLOW', postFixReasons: ['ADDRESS2_PRESENT', 'DEPT_MISMATCH'],
    note: 'H-4: landmark description ("Casa rejas grises...") correctly surfaces ADDRESS2_PRESENT.' },
  { tag: 'real-1143', input: order(4, { address1: 'Rondeau Entre Calle D Y Piedras S/n', city: 'Nueva Palmira' }),
    baselineZone: 'YELLOW', baselineReasons: ['DEPT_MISMATCH'], change: 'none' },
  { tag: 'real-1142', input: order(5, { address1: 'Otilia Schultze 668bis', city: 'Durazno' }),
    baselineZone: 'YELLOW', baselineReasons: ['DEPT_MISMATCH'], change: 'none',
    note: '"668bis" has no SPACE before "bis" → " bis" marker does not match → no APT_IN_ADDRESS1. DEPT_MISMATCH due to province default "Montevideo".' },
  { tag: 'real-1141', input: order(6, { address1: 'Lavalleja 444', city: 'Minas' }),
    baselineZone: 'YELLOW', baselineReasons: ['DEPT_MISMATCH'], change: 'none' },
  { tag: 'real-1140', input: order(7, { address1: '18 De Julio 319 o 405', address2: 'Apto 102', city: 'Tacuarembo' }),
    baselineZone: 'YELLOW', baselineReasons: ['DEPT_MISMATCH'], change: 'none' },
  { tag: 'real-1139', input: order(8, { address1: 'Av.Agraciada 3069', address2: 'apto 201', city: 'Bella Vista' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none' },
  { tag: 'real-1138', input: order(9, { address1: 'Liorna 6518', address2: '103 ( Susana De Haedo)', city: 'Carrasco' }),
    baselineZone: 'YELLOW', baselineReasons: ['ADDRESS2_PRESENT'], change: 'none' },
  { tag: 'real-1137', input: order(10, { address1: 'Canelones 1450', address2: '099680230', city: 'Centro/Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['ADDRESS2_PRESENT'], change: 'none' },
  { tag: 'real-1136', input: order(11, { address1: 'Luis Bonavita 1266 tore 4 WTC', address2: 'Montevideo', city: 'Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['ADDRESS2_PRESENT'], change: 'none' },
  { tag: 'real-1135', input: order(12, { address1: 'Benone Calcavecchia 4718', city: 'Malvín Norte' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none' },
  { tag: 'real-1134', input: order(13, { address1: 'Avenida batlle y Ordoñez 723', address2: 'Oficinas Pablo Arenas viajes', city: 'Nueva Helvecia' }),
    baselineZone: 'YELLOW', baselineReasons: ['ADDRESS2_PRESENT', 'DEPT_MISMATCH'], change: 'none' },
  { tag: 'real-1133', input: order(14, { address1: 'Jardines Del Hum B09', address2: 'Casa portones blancos', city: 'Jardines del Hum' }),
    baselineZone: 'YELLOW', baselineReasons: ['DEPT_MISMATCH'], change: 'H-4',
    postFixZone: 'YELLOW', postFixReasons: ['ADDRESS2_PRESENT', 'DEPT_MISMATCH'],
    note: 'H-4: "Casa portones blancos" landmark description → ADDRESS2_PRESENT surfaces correctly.' },
  { tag: 'real-1132', input: order(15, { address1: 'gestido 2865', address2: 'casa', city: 'pocitos' }),
    baselineZone: 'YELLOW', baselineReasons: ['ADDRESS2_PRESENT'], change: 'none',
    note: 'address2="casa" bare (no trailing space) — does NOT match "casa " pattern → ADDRESS2_PRESENT.' },
  { tag: 'real-1131', input: order(16, { address1: 'Calle 24 entre 27 y 28 , local 110 ,1er piso , galería paseo del mar', address2: 'Local 110', city: 'Maldonado' }),
    baselineZone: 'YELLOW', baselineReasons: ['ADDRESS2_PRESENT', 'APT_IN_ADDRESS1', 'DEPT_MISMATCH'], change: 'none' },
  { tag: 'real-1130', input: order(17, { address1: 'Canelones 1417', address2: '002', city: 'Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['ADDRESS2_PRESENT'], change: 'none' },
  { tag: 'real-1129', input: order(18, { address1: 'Pedro Fco. Berro 785', address2: 'apto 602', city: 'Montevideo' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none',
    note: '"Pedro Fco." does NOT contain "p." substring (no adjacent "p" + "."). Classifier stays GREEN.' },
  { tag: 'real-1128', input: order(19, { address1: 'Juan Paullier 1491', city: '2|montevideo' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none',
    note: 'Baseline: city lowercases to "2|montevideo", getDepartmentForCity normalizes it (tolerates prefix) → mapped → no UNKNOWN_CITY.' },
  { tag: 'real-1127', input: order(20, { address1: 'Rogelio Sosa', address2: 'Casa', city: 'Cardona' }),
    baselineZone: 'YELLOW', baselineReasons: ['ADDRESS2_PRESENT', 'DEPT_MISMATCH'], change: 'none' },

  // ── SYNTHETIC (audit-flagged false positives + edge cases) ───────────
  { tag: 'syn-torres-de-carrasco', input: order(21, { address1: 'Torres de Carrasco 1500', city: 'Montevideo' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none',
    note: 'Audit flagged this as a false positive but in practice "torres " does NOT contain " torre " substring — baseline is GREEN already.' },
  { tag: 'syn-casa-blanca-barrio', input: order(22, { address1: 'Calle X 500', city: 'Casa Blanca' }),
    baselineZone: 'YELLOW', baselineReasons: ['UNKNOWN_CITY'], change: 'none' },
  { tag: 'syn-av-brasil-ter', input: order(23, { address1: 'Av. Brasil Ter', city: 'Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['APT_IN_ADDRESS1'], change: 'H-4',
    postFixZone: 'GREEN', postFixReasons: [],
    note: 'H-4: " ter" is number modifier (tercero), not apartment. Strict regex drops it.' },
  { tag: 'syn-bis-suffix', input: order(24, { address1: 'Rivera 2345 bis', city: 'Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['APT_IN_ADDRESS1'], change: 'H-4',
    postFixZone: 'GREEN', postFixReasons: [],
    note: 'H-4: " bis" is number modifier, not apt. Strict regex drops it.' },
  { tag: 'syn-dr-p-name', input: order(25, { address1: 'Dr. P. Russo 5678', city: 'Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['APT_IN_ADDRESS1'], change: 'H-4',
    postFixZone: 'GREEN', postFixReasons: [],
    note: 'H-4: "P." in honorifics should not trigger APT. Strict regex requires "piso <digit>" context.' },
  { tag: 'syn-real-apt', input: order(26, { address1: 'Av. Italia 4500 apto 5', city: 'Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['APT_IN_ADDRESS1'], change: 'none',
    note: 'Real APT — must REMAIN YELLOW post-fix.' },
  { tag: 'syn-real-piso', input: order(27, { address1: 'Colonia 1234 Piso 3', city: 'Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['APT_IN_ADDRESS1'], change: 'none',
    note: 'Real PISO — must REMAIN YELLOW post-fix.' },
  { tag: 'syn-real-torre', input: order(28, { address1: 'Av. Brasil 2500 Torre 2 Apto 5', city: 'Montevideo' }),
    baselineZone: 'YELLOW', baselineReasons: ['APT_IN_ADDRESS1'], change: 'none',
    note: 'Real TORRE+APTO — must REMAIN YELLOW post-fix.' },

  // Phone edge cases (H-3) — currently 7-13 range is accepted.
  { tag: 'syn-phone-7digits', input: order(29, { phone: '1234567' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'H-3',
    postFixZone: 'YELLOW', postFixReasons: ['WEIRD_PHONE'],
    note: 'H-3: 7 digits is not a valid UY phone. Must flag WEIRD_PHONE.' },
  { tag: 'syn-phone-10digits', input: order(30, { phone: '1234567890' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'H-3',
    postFixZone: 'YELLOW', postFixReasons: ['WEIRD_PHONE'],
    note: 'H-3: 10 digits with no valid UY shape. Must flag WEIRD_PHONE.' },
  { tag: 'syn-phone-moviluy-local', input: order(31, { phone: '099123456' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none' },
  { tag: 'syn-phone-fijomvd-local', input: order(32, { phone: '24005000' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none' },
  { tag: 'syn-phone-movil-plus598', input: order(33, { phone: '+59899123456' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none' },
  { tag: 'syn-phone-empty', input: order(34, { phone: null }),
    baselineZone: 'YELLOW', baselineReasons: ['WEIRD_PHONE'], change: 'none' },
  { tag: 'syn-phone-nodigits', input: order(35, { phone: 'llamar al timbre' }),
    baselineZone: 'YELLOW', baselineReasons: ['WEIRD_PHONE'], change: 'none' },

  // Address edge cases that H-5 might touch.
  { tag: 'syn-trailing-known-mvd', input: order(36, { address1: 'Calle X 500, Montevideo', city: 'Montevideo' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none' },
  { tag: 'syn-trailing-unknown-punta-del-diablo', input: order(37, { address1: 'Avenida Hondo 234, Punta del Diablo', city: 'Punta del Diablo' }),
    baselineZone: 'YELLOW', baselineReasons: ['DEPT_MISMATCH'], change: 'none',
    note: 'City "Punta del Diablo" IS in CITY_TO_DEPARTMENT (Rocha). DEPT_MISMATCH due to province=Montevideo default.' },
  { tag: 'syn-calle-name-is-barrio', input: order(38, { address1: 'Pocitos 1234', city: 'Montevideo' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none',
    note: 'BarrioName as street — must stay GREEN. H-5 must preserve this (no comma = no strip).' },
  { tag: 'syn-calle-rivera', input: order(39, { address1: 'Rivera 2345', city: 'Montevideo' }),
    baselineZone: 'GREEN', baselineReasons: [], change: 'none',
    note: 'Rivera as street (not dept). Must stay GREEN.' },
  { tag: 'syn-red-no-country', input: order(40, { address1: '', city: '' }),
    baselineZone: 'RED', baselineReasons: ['NO_ADDRESS1', 'NO_CITY'], change: 'none' },
];

/**
 * APPLIED_FIXES governs which postFix expectations are asserted vs baseline.
 * Add the fix tag here the moment you land the fix; the test will then enforce
 * the postFix* values. For fixes NOT listed here, baseline still holds.
 */
const APPLIED_FIXES: ReadonlySet<Fixture['change']> = new Set(['H-3', 'H-4']);

function expectedZone(f: Fixture): Fixture['baselineZone'] {
  if (APPLIED_FIXES.has(f.change) && f.postFixZone) return f.postFixZone;
  return f.baselineZone;
}

function expectedReasons(f: Fixture): string[] {
  if (APPLIED_FIXES.has(f.change) && f.postFixReasons) return f.postFixReasons;
  return f.baselineReasons;
}

describe('classifier regression fixtures — snapshot across fix lifecycle', () => {
  it.each(FIXTURES.map(f => [f.tag, f]))(
    '%s — bucket & reasons match current expectation',
    (_tag, f) => {
      const fix = f as Fixture;
      const r = classifyOrder(fix.input);
      const sortedActual = [...r.reasons].sort();
      const sortedExpected = [...expectedReasons(fix)].sort();
      expect(r.zone, `${fix.tag} zone drifted. note: ${fix.note ?? '—'}`).toBe(expectedZone(fix));
      expect(sortedActual, `${fix.tag} reasons drifted. note: ${fix.note ?? '—'}`).toEqual(sortedExpected);
    },
  );
});

describe('classifier regression fixtures — fix-tracking metadata', () => {
  it('documents which fixtures are expected to change, grouped by fix', () => {
    const changed = FIXTURES.filter(f => f.change !== 'none');
    // If this list changes, confirm the fix was intentional and update APPLIED_FIXES.
    expect(changed.map(f => f.tag)).toEqual([
      'real-1145',             // H-4 — Casa landmark → ADDRESS2_PRESENT
      'real-1144',             // H-4 — Casa landmark → ADDRESS2_PRESENT
      'real-1133',             // H-4 — Casa landmark → ADDRESS2_PRESENT
      'syn-av-brasil-ter',     // H-4 — " ter" is number modifier, not apt
      'syn-bis-suffix',        // H-4 — " bis" is number modifier, not apt
      'syn-dr-p-name',         // H-4 — "P." collides with Dr. P. style names
      'syn-phone-7digits',     // H-3
      'syn-phone-10digits',    // H-3
    ]);
  });
});
