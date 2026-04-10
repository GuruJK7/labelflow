/**
 * Regression tests for the LabelFlow-internal marker sanitizer.
 *
 * Background: LabelFlow writes a marker to the Shopify order note after each
 * successful shipment (format: "LabelFlow-GUIA: <guia> | <timestamp>"). This
 * marker lets the cron skip already-processed orders on subsequent runs.
 *
 * THE BUG: the original filter used `String.prototype.includes('LabelFlow-GUIA:')`,
 * which is case-sensitive. Store owners, plugins, or older versions of our own
 * code sometimes inserted lowercase/variant markers ("labelflow-guia", "labelflow_guia",
 * "labelflow guia"). The filter missed those variants, so the internal marker
 * leaked into DAC's observations field — a customer-visible field that the
 * courier reads. This exposed internal guia numbers and confused couriers.
 *
 * Worse, `order.note_attributes` was pushed to observations with ZERO filtering,
 * so any Shopify attribute named "labelflow-guia" (or containing the marker in
 * its value) went straight through to DAC.
 *
 * THE FIX: a single regex (LABELFLOW_MARKER_RE) matches every variant we've
 * seen in the wild. It's applied at three layers as belt-and-suspenders:
 *   1. order.note split by newlines — reject any line matching the regex
 *   2. order.note_attributes — reject any attr whose name OR value matches
 *   3. final combined observations — split each by \n|| and strip any piece
 *      that matches
 *
 * These tests lock the regex down so the bug cannot return silently.
 */

import { describe, it, expect } from 'vitest';
import {
  LABELFLOW_MARKER_RE,
  LABELFLOW_WORD_RE,
  ISO_TIMESTAMP_RE,
  LONG_NUMERIC_ID_RE,
  INTERNAL_METADATA_NAME_RE,
  isLabelflowInternal,
  shouldSkipNoteAttribute,
  sanitizeObservationLine,
} from '../dac/shipment';

describe('LABELFLOW_MARKER_RE — marker detection regex', () => {
  // ───────────────────────────────────────────────────────────────────────
  // POSITIVE cases — these MUST match
  // ───────────────────────────────────────────────────────────────────────

  it('matches the canonical mixed-case marker written by our code', () => {
    expect(LABELFLOW_MARKER_RE.test('LabelFlow-GUIA: 882277945994')).toBe(true);
  });

  it('matches lowercase marker (the variant that caused the production bug)', () => {
    expect(LABELFLOW_MARKER_RE.test('labelflow-guia: 882277945994')).toBe(true);
  });

  it('matches UPPERCASE marker', () => {
    expect(LABELFLOW_MARKER_RE.test('LABELFLOW-GUIA: 882277945994')).toBe(true);
  });

  it('matches marker with underscore separator', () => {
    expect(LABELFLOW_MARKER_RE.test('labelflow_guia: 882277945994')).toBe(true);
  });

  it('matches marker with space separator', () => {
    expect(LABELFLOW_MARKER_RE.test('labelflow guia: 882277945994')).toBe(true);
  });

  it('matches marker with no separator (squished)', () => {
    expect(LABELFLOW_MARKER_RE.test('labelflowguia: 882277945994')).toBe(true);
  });

  it('matches Spanish accented variant "labelflow-guía"', () => {
    expect(LABELFLOW_MARKER_RE.test('labelflow-guía: 882277945994')).toBe(true);
  });

  it('matches Spanish uppercase accented variant', () => {
    expect(LABELFLOW_MARKER_RE.test('LABELFLOW-GUÍA: 882277945994')).toBe(true);
  });

  it('matches error marker "LabelFlow ERROR:"', () => {
    expect(LABELFLOW_MARKER_RE.test('LabelFlow ERROR: No shipping address')).toBe(true);
  });

  it('matches lowercase error variant', () => {
    expect(LABELFLOW_MARKER_RE.test('labelflow-error: something')).toBe(true);
  });

  it('matches when embedded inside other text (the real-world observation leak)', () => {
    const leakedText =
      'casa con rejas grises pegado a pizzería "la barra". labelflow-guia: 882277945994';
    expect(LABELFLOW_MARKER_RE.test(leakedText)).toBe(true);
  });

  // ── REVERSED-ORDER VARIANTS (Guía labelflow: ...) ──
  // Reported 2026-04-10 in a second screenshot after the first fix.
  // The v1 regex only matched labelflow→guia; the v2 regex adds a branch
  // for guia→labelflow order.

  it('matches "Guía labelflow: N" (reversed order, Spanish accent)', () => {
    expect(LABELFLOW_MARKER_RE.test('Guía labelflow: 882277908035')).toBe(true);
  });

  it('matches "guia labelflow" (reversed order, lowercase, no accent)', () => {
    expect(LABELFLOW_MARKER_RE.test('guia labelflow: 123')).toBe(true);
  });

  it('matches "GUÍA LABELFLOW" (reversed order, uppercase accent)', () => {
    expect(LABELFLOW_MARKER_RE.test('GUÍA LABELFLOW: 456')).toBe(true);
  });

  it('matches "guía-labelflow" (reversed order, hyphen separator)', () => {
    expect(LABELFLOW_MARKER_RE.test('guía-labelflow: 789')).toBe(true);
  });

  it('matches "guía_labelflow" (reversed order, underscore separator)', () => {
    expect(LABELFLOW_MARKER_RE.test('guía_labelflow: 789')).toBe(true);
  });

  it('matches reversed marker when embedded in real observation text', () => {
    // Direct copy from row 8 of the DAC screenshot on 2026-04-10
    const leaked = 'Guía labelflow: 882277908035';
    expect(LABELFLOW_MARKER_RE.test(leaked)).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // NEGATIVE cases — these must NOT match (legitimate content)
  // ───────────────────────────────────────────────────────────────────────

  it('does NOT match unrelated shipping instructions', () => {
    expect(LABELFLOW_MARKER_RE.test('Apto 701 | no enviar')).toBe(false);
  });

  it('does NOT match address text with numbers', () => {
    expect(LABELFLOW_MARKER_RE.test('18 de Julio 1234, Montevideo')).toBe(false);
  });

  it('does NOT match "guia" alone without "labelflow" prefix', () => {
    expect(LABELFLOW_MARKER_RE.test('guia 882277945994')).toBe(false);
  });

  it('v3 change: the bare word "labelflow" IS now blocked (defensive stance)', () => {
    // Previously (v1/v2) this test asserted the opposite — a bare "labelflow"
    // without guia/error was allowed. v3 takes a defensive stance: our brand
    // name should never appear in customer-facing DAC observations under any
    // circumstance, so ANY case-insensitive match of "labelflow" is blocked.
    // This eliminates an entire class of edge cases where separators or
    // word order tricks let the marker slip through.
    expect(LABELFLOW_MARKER_RE.test('Sent via labelflow')).toBe(true);
  });

  it('does NOT match partial matches like "label" or "flow"', () => {
    expect(LABELFLOW_MARKER_RE.test('label printer problem')).toBe(false);
    expect(LABELFLOW_MARKER_RE.test('flow of traffic')).toBe(false);
  });

  it('does NOT match real customer references containing numbers', () => {
    expect(LABELFLOW_MARKER_RE.test('Ref: 123456789')).toBe(false);
    expect(LABELFLOW_MARKER_RE.test('Guía del turista no disponible')).toBe(false);
  });
});

describe('sanitizeObservationLine — strips markers from combined observation text', () => {
  it('keeps untouched when no marker present', () => {
    expect(sanitizeObservationLine('Casa rejas grises')).toBe('Casa rejas grises');
  });

  it('strips marker appended after a legitimate note (real-world case)', () => {
    const dirty =
      'casa con rejas grises pegado a pizzería "la barra" | labelflow-guia: 882277945994';
    const clean = sanitizeObservationLine(dirty);
    expect(clean).toBe('casa con rejas grises pegado a pizzería "la barra"');
    expect(clean).not.toContain('labelflow');
    expect(clean).not.toContain('882277945994');
  });

  it('strips marker split across newlines', () => {
    const dirty = 'Apto 4B\nlabelflow-guia: 123\nPortero: Juan';
    const clean = sanitizeObservationLine(dirty);
    expect(clean).toBe('Apto 4B Portero: Juan');
  });

  it('strips uppercase marker', () => {
    const dirty = 'Portero: Juan | LABELFLOW-GUIA: 999';
    expect(sanitizeObservationLine(dirty)).toBe('Portero: Juan');
  });

  it('collapses multiple whitespace after stripping', () => {
    const dirty = 'Note   with     spaces | labelflow-guia: 1';
    expect(sanitizeObservationLine(dirty)).toBe('Note with spaces');
  });

  it('returns empty string when the entire input is a marker', () => {
    expect(sanitizeObservationLine('labelflow-guia: 882277945994')).toBe('');
  });

  it('v3 change: strips BOTH the marker AND the bare ISO timestamp', () => {
    // In v2 the bare timestamp piece survived the sanitizer because only the
    // labelflow-marker piece matched the regex. In v3, the filter now ALSO
    // blocks ISO 8601 timestamps (Signal 3 in the filter architecture).
    // So the entire input reduces to empty — both halves are stripped.
    expect(sanitizeObservationLine('LabelFlow-GUIA: 123 | 2026-04-10T15:00:00Z')).toBe('');
  });

  it('strips marker mixed with pipe separators', () => {
    const dirty = 'Apto 5 | labelflow-guia: 1 | Portero';
    expect(sanitizeObservationLine(dirty)).toBe('Apto 5 Portero');
  });

  it('handles the exact real-world leak pattern from the DAC screenshot (row 3 — labelflow-guia)', () => {
    // Exact text from row 3 of the 2026-04-10 DAC historial screenshot for
    // order #1144 Pablo Rodríguez.
    const dirty =
      'Casa rejas grises pegado a pizeria "la barra" | casa con rejas grises pegado a pizzería "la barra". labelflow-guia: 882277945994';
    const clean = sanitizeObservationLine(dirty);
    expect(clean).not.toContain('labelflow');
    expect(clean).not.toContain('882277945994');
    expect(clean).not.toContain(':');
    // Sanity: the legitimate parts should still be there
    expect(clean).toContain('Casa rejas grises');
    expect(clean).toContain('pizeria');
  });

  it('handles the reversed-order leak (row 8 of the 2026-04-10 screenshot — Guía labelflow)', () => {
    // Row 8: Marcelo perez / Otilia schultze 668bis. The observation was just
    // the bare marker with reversed word order, so the entire content must be
    // stripped to the empty string.
    const dirty = 'Guía labelflow: 882277908035';
    expect(sanitizeObservationLine(dirty)).toBe('');
  });

  it('handles the reversed-order leak embedded in legitimate text', () => {
    const dirty = 'Portero: Juan | Guía labelflow: 882277908035 | Apto 3';
    const clean = sanitizeObservationLine(dirty);
    expect(clean).not.toContain('labelflow');
    expect(clean).not.toContain('882277908035');
    expect(clean).toContain('Portero: Juan');
    expect(clean).toContain('Apto 3');
  });

  it('is idempotent (sanitizing twice gives the same result)', () => {
    const dirty = 'Apto 5 | labelflow-guia: 1 | Portero Juan';
    const once = sanitizeObservationLine(dirty);
    const twice = sanitizeObservationLine(once);
    expect(twice).toBe(once);
  });

  it('preserves empty string input', () => {
    expect(sanitizeObservationLine('')).toBe('');
  });

  it('preserves whitespace-only input as empty', () => {
    expect(sanitizeObservationLine('   ')).toBe('');
  });

  // ── v3 REAL-WORLD LEAKS (reported 2026-04-10 in the third screenshot) ──

  it('v3: handles "Guía: labelflow: N" with colon separator (v2 missed this)', () => {
    const dirty = 'Guía: labelflow: 882277908035';
    expect(sanitizeObservationLine(dirty)).toBe('');
  });

  it('v3: handles bare "Fecha: <ISO timestamp>" (no labelflow keyword)', () => {
    const dirty = 'Fecha: 2026-04-06t17:12:57.789z';
    expect(sanitizeObservationLine(dirty)).toBe('');
  });

  it('v3: strips bare long numeric ID (Signal 4: LONG_NUMERIC_ID_RE)', () => {
    expect(sanitizeObservationLine('882277908035')).toBe('');
  });

  it('v3: preserves short numbers that are probably apartment numbers', () => {
    expect(sanitizeObservationLine('Apto 3')).toBe('Apto 3');
    expect(sanitizeObservationLine('Piso 12')).toBe('Piso 12');
  });

  it('v3: preserves legitimate delivery dates in human format', () => {
    const ok = 'Entregar el 11/04/2026 entre las 14 y 18 hs';
    expect(sanitizeObservationLine(ok)).toBe(ok);
  });

  it('v3: integration — strips all leak patterns, keeps legitimate parts', () => {
    const dirty =
      'Portero: Juan | Guía: labelflow: 882277908035 | Fecha: 2026-04-06T17:12:57.789Z | Apto 5 | 1234567890';
    const clean = sanitizeObservationLine(dirty);
    expect(clean).toContain('Portero: Juan');
    expect(clean).toContain('Apto 5');
    expect(clean).not.toContain('labelflow');
    expect(clean).not.toContain('882277908035');
    expect(clean).not.toContain('2026-04-06');
    expect(clean).not.toContain('1234567890');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// v3 FILTER ARCHITECTURE — isLabelflowInternal + shouldSkipNoteAttribute
// ───────────────────────────────────────────────────────────────────────────

describe('isLabelflowInternal — combined label+timestamp detection', () => {
  it('returns true for any case variant of "labelflow"', () => {
    expect(isLabelflowInternal('labelflow')).toBe(true);
    expect(isLabelflowInternal('LabelFlow')).toBe(true);
    expect(isLabelflowInternal('LABELFLOW')).toBe(true);
    expect(isLabelflowInternal('sent via labelflow yesterday')).toBe(true);
  });

  it('returns true for any ISO 8601 timestamp', () => {
    expect(isLabelflowInternal('2026-04-06T17:12:57.789Z')).toBe(true);
    expect(isLabelflowInternal('Fecha: 2026-04-06T17:12:57')).toBe(true);
    expect(isLabelflowInternal('timestamp=2026-04-10 15:00:00')).toBe(true);
  });

  it('returns false for legitimate delivery instructions', () => {
    expect(isLabelflowInternal('Apto 3')).toBe(false);
    expect(isLabelflowInternal('Casa amarilla con rejas')).toBe(false);
    expect(isLabelflowInternal('Entregar antes de las 18hs')).toBe(false);
  });

  it('returns false for empty / whitespace', () => {
    expect(isLabelflowInternal('')).toBe(false);
    expect(isLabelflowInternal('   ')).toBe(false);
  });
});

describe('shouldSkipNoteAttribute — Shopify note_attribute filter', () => {
  it('skips attribute whose name contains labelflow', () => {
    expect(shouldSkipNoteAttribute('labelflow-guia', '882277908035')).toBe(true);
    expect(shouldSkipNoteAttribute('LabelFlow-GUIA', '882277908035')).toBe(true);
  });

  it('skips attribute whose value contains labelflow', () => {
    expect(shouldSkipNoteAttribute('random_name', 'labelflow reference')).toBe(true);
  });

  it('skips attribute whose name matches metadata patterns (guia, tracking, fecha, etc)', () => {
    expect(shouldSkipNoteAttribute('Guía', '882277908035')).toBe(true);
    expect(shouldSkipNoteAttribute('Fecha', '2026-04-06T17:12:57.789Z')).toBe(true);
    expect(shouldSkipNoteAttribute('Tracking', 'ABC123')).toBe(true);
    expect(shouldSkipNoteAttribute('timestamp', 'whatever')).toBe(true);
    expect(shouldSkipNoteAttribute('label', 'whatever')).toBe(true);
    expect(shouldSkipNoteAttribute('internal', 'whatever')).toBe(true);
  });

  it('skips attribute whose value is a bare long numeric ID', () => {
    expect(shouldSkipNoteAttribute('external_id', '882277908035')).toBe(true);
  });

  it('skips attribute whose value is an ISO timestamp', () => {
    expect(shouldSkipNoteAttribute('created_at', '2026-04-06T17:12:57.789Z')).toBe(true);
  });

  it('ALLOWS legitimate delivery instruction attributes', () => {
    expect(shouldSkipNoteAttribute('delivery_instructions', 'Leave at the door')).toBe(false);
    expect(shouldSkipNoteAttribute('gift_message', 'Feliz cumpleaños!')).toBe(false);
    expect(shouldSkipNoteAttribute('apartment', '3B')).toBe(false);
    expect(shouldSkipNoteAttribute('phone', '099123456')).toBe(false); // 9 digits stays
  });
});

describe('v3 individual detection signals', () => {
  it('LABELFLOW_WORD_RE matches labelflow in any case', () => {
    expect(LABELFLOW_WORD_RE.test('LabelFlow')).toBe(true);
    expect(LABELFLOW_WORD_RE.test('labelflow')).toBe(true);
    expect(LABELFLOW_WORD_RE.test('LABELFLOW')).toBe(true);
    expect(LABELFLOW_WORD_RE.test('notflow')).toBe(false);
  });

  it('ISO_TIMESTAMP_RE matches ISO 8601 but not other date formats', () => {
    expect(ISO_TIMESTAMP_RE.test('2026-04-06T17:12:57.789Z')).toBe(true);
    expect(ISO_TIMESTAMP_RE.test('2026-04-06t17:12:57.789z')).toBe(true);
    expect(ISO_TIMESTAMP_RE.test('2026-04-06 17:12:57')).toBe(true);
    expect(ISO_TIMESTAMP_RE.test('11/04/2026 14:00')).toBe(false);
    expect(ISO_TIMESTAMP_RE.test('2026-04-06')).toBe(false);
  });

  it('LONG_NUMERIC_ID_RE matches 10+ digit standalone numbers only', () => {
    expect(LONG_NUMERIC_ID_RE.test('882277908035')).toBe(true);
    expect(LONG_NUMERIC_ID_RE.test('1234567890')).toBe(true);
    expect(LONG_NUMERIC_ID_RE.test('123456789')).toBe(false); // 9 digits — could be phone
    expect(LONG_NUMERIC_ID_RE.test('Apto 1234567890')).toBe(false); // has text
  });

  it('INTERNAL_METADATA_NAME_RE matches common metadata field names', () => {
    expect(INTERNAL_METADATA_NAME_RE.test('Guía')).toBe(true);
    expect(INTERNAL_METADATA_NAME_RE.test('guia')).toBe(true);
    expect(INTERNAL_METADATA_NAME_RE.test('tracking')).toBe(true);
    expect(INTERNAL_METADATA_NAME_RE.test('Fecha')).toBe(true);
    expect(INTERNAL_METADATA_NAME_RE.test('timestamp')).toBe(true);
    expect(INTERNAL_METADATA_NAME_RE.test('label')).toBe(true);
    expect(INTERNAL_METADATA_NAME_RE.test('delivery_instructions')).toBe(false);
    expect(INTERNAL_METADATA_NAME_RE.test('customer_note')).toBe(false);
    expect(INTERNAL_METADATA_NAME_RE.test('apartment')).toBe(false);
  });
});
