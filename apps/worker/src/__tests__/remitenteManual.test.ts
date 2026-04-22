import { describe, it, expect } from 'vitest';
import {
  buildRemitenteShopifyNote,
  REMITENTE_NOTE_DEDUP_PREFIX_LEN,
  REMITENTE_LABEL_MESSAGE,
} from '../dac/remitente-manual';

// 2026-04-22 — locks in the contract for the REMITENTE manual-handoff
// note. Two job files (process-orders.job.ts and agent-bulk-upload.job.ts)
// use these helpers; both the note body AND the leading-prefix dedup
// check must agree, or reprocess cycles will spam Shopify with duplicate
// notes.

describe('buildRemitenteShopifyNote — Spanish operator note body', () => {
  it('starts with the LabelFlow-REMITENTE marker so dedup prefix is stable', () => {
    const note = buildRemitenteShopifyNote(3750);
    expect(note.startsWith('LabelFlow: este envío debe pagarlo el remitente')).toBe(true);
  });

  it('formats the total as a 2-decimal UYU amount', () => {
    expect(buildRemitenteShopifyNote(3750)).toContain('$3750.00 UYU');
    expect(buildRemitenteShopifyNote(4200.5)).toContain('$4200.50 UYU');
    expect(buildRemitenteShopifyNote(999.999)).toContain('$1000.00 UYU');
  });

  it('mentions the manual-load instruction (operator must act)', () => {
    const note = buildRemitenteShopifyNote(1000);
    expect(note).toContain('cargalo a mano en DAC');
  });

  it('mentions the Fulfilled handoff so the operator knows how to close the loop', () => {
    const note = buildRemitenteShopifyNote(1000);
    expect(note).toContain('Fulfilled');
    expect(note).toContain('saca de la cola');
  });

  it('is resilient to NaN / negative / zero totals (never crashes or leaks NaN into Shopify)', () => {
    expect(buildRemitenteShopifyNote(NaN)).toContain('$0.00 UYU');
    expect(buildRemitenteShopifyNote(-50)).toContain('$0.00 UYU');
    expect(buildRemitenteShopifyNote(0)).toContain('$0.00 UYU');
  });

  it('dedup prefix is stable across repeated calls with the same total (reprocess idempotency)', () => {
    // The dedup use-case is: same Shopify order reprocessed on the next
    // cron cycle. Total is the same both times, so the first-80-chars
    // prefix must match exactly so `currentNote.includes(prefix)` returns
    // true and the note is NOT re-written.
    const first = buildRemitenteShopifyNote(3750)
      .substring(0, REMITENTE_NOTE_DEDUP_PREFIX_LEN);
    const second = buildRemitenteShopifyNote(3750)
      .substring(0, REMITENTE_NOTE_DEDUP_PREFIX_LEN);
    expect(first).toBe(second);
  });

  it('dedup prefix length is at least 40 chars (specific enough to not match other LabelFlow notes)', () => {
    // Sanity: too short a prefix could collide with the DacAddressRejectedError
    // note, which starts with "LabelFlow: no se pudo crear el envío en DAC".
    expect(REMITENTE_NOTE_DEDUP_PREFIX_LEN).toBeGreaterThanOrEqual(40);

    const remPrefix = buildRemitenteShopifyNote(1000).substring(0, REMITENTE_NOTE_DEDUP_PREFIX_LEN);
    const addrRejectedSampleStart = 'LabelFlow: no se pudo crear el envío en DAC — dirección confusa';
    expect(remPrefix.includes(addrRejectedSampleStart)).toBe(false);
  });
});

describe('REMITENTE_LABEL_MESSAGE — Label.errorMessage for dashboard', () => {
  it('is Spanish, short, and descriptive', () => {
    expect(REMITENTE_LABEL_MESSAGE).toBe('Envío REMITENTE — cargar manualmente en DAC');
  });

  it('fits in Label.errorMessage without truncation (schema field is String, but we aim < 200 chars)', () => {
    expect(REMITENTE_LABEL_MESSAGE.length).toBeLessThan(200);
  });
});
