// isEmpaqueCommitted — the load-bearing decision of the last-mile empaque guard
// (audit 2026-06-07). DAC SILENT-rejects at Finalizar when K_Tipo_Empaque is
// left at the "Seleccione..." placeholder because Choices.js reverted the native
// <select> after we committed it. This predicate decides whether the native
// select currently holds a real package-type value (so the guard knows whether
// it must re-commit before Agregar). Confirmed prod cases: #1917/#1907/#1913/
// #1916/#1914/#1743 had empaque empty at reject time.

import { describe, it, expect } from 'vitest';
import { isEmpaqueCommitted } from '../dac/shipment';

describe('isEmpaqueCommitted', () => {
  // ── committed (real value) ──────────────────────────────────────────────
  it('true when a real package type is selected', () => {
    expect(isEmpaqueCommitted({ present: true, value: '1', text: 'Hasta 2Kg 20x20x20' })).toBe(true);
  });

  it('true for any non-zero value with a non-placeholder text', () => {
    expect(isEmpaqueCommitted({ present: true, value: '3', text: 'Hasta 5Kg 30x30x30' })).toBe(true);
  });

  // ── NOT committed — the silent-reject conditions ────────────────────────
  it('false when value is empty (never set)', () => {
    expect(isEmpaqueCommitted({ present: true, value: '', text: 'Seleccione...' })).toBe(false);
  });

  it('false when value is the "0" placeholder', () => {
    expect(isEmpaqueCommitted({ present: true, value: '0', text: 'Seleccione una opcion' })).toBe(false);
  });

  it('false when text says "Seleccione" even if a value leaked in (Choices.js desync)', () => {
    // Defensive: the native value can briefly hold a number while the visible
    // option text still reads the placeholder mid-revert. Treat as NOT committed.
    expect(isEmpaqueCommitted({ present: true, value: '1', text: 'Seleccione...' })).toBe(false);
  });

  it('false (case-insensitive) for "SELECCIONE"', () => {
    expect(isEmpaqueCommitted({ present: true, value: '2', text: 'SELECCIONE' })).toBe(false);
  });

  it('false when the select is not present in the DOM', () => {
    expect(isEmpaqueCommitted({ present: false, value: '', text: '' })).toBe(false);
  });

  it('false when present but everything is empty', () => {
    expect(isEmpaqueCommitted({ present: true, value: '', text: '' })).toBe(false);
  });
});
