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

  it('does NOT match the word "labelflow" without guia/error', () => {
    expect(LABELFLOW_MARKER_RE.test('Sent via labelflow')).toBe(false);
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

  it('strips marker portion but preserves separate pipe-delimited pieces', () => {
    // When the sanitizer encounters "marker | bare-timestamp", it splits on the
    // pipe and only strips the marker piece — the timestamp survives. This is
    // acceptable for two reasons:
    //   (a) at the order.note.split('\n') level upstream, the entire line would
    //       already be filtered because the full line matches LABELFLOW_MARKER_RE
    //   (b) a bare ISO timestamp in observations is not a data leak — no internal
    //       guia number or error prefix remains
    expect(sanitizeObservationLine('LabelFlow-GUIA: 123 | 2026-04-10T15:00:00Z')).toBe(
      '2026-04-10T15:00:00Z',
    );
  });

  it('strips marker mixed with pipe separators', () => {
    const dirty = 'Apto 5 | labelflow-guia: 1 | Portero';
    expect(sanitizeObservationLine(dirty)).toBe('Apto 5 Portero');
  });

  it('handles the exact real-world leak pattern from the DAC screenshot', () => {
    // This is the exact text that was observed leaking into DAC historial on
    // 2026-04-10 for order #1144 Pablo Rodríguez. The bug was reported with a
    // screenshot showing this text in the DAC observations field.
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
});
