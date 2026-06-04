import { describe, it, expect } from 'vitest';
import {
  parseHistorialRowDate,
  isHistorialRowRecent,
  pickMatchingHistorialRow,
} from '../dac/shipment';

// Tests for the 2026-06-04 orphan-reconcile deep-scan + recency gate.
//
// Context: DAC silent-rejects ~10% of valid forms but STILL mints the guía.
// The inline rescue catches most (guía at top of historial), but the misses
// land as ORPHANED. By the time orphan-reconcile runs (30 min+ later) a
// high-volume tenant has buried that guía past the inline 3-page window, so
// re-running the identical scan recovers nothing. The fix scans DEEPER, made
// safe by a RECENCY GATE: only adopt a guía whose historial DD/MM stamp is
// within ±N days of the order's submitAttemptedAt. These tests lock in the
// date parsing and prove the gate filters an old same-name shipment (the
// #11481 / #11865 poisoning class) while keeping the recent one.

type Row = { guia: string; href: string | null; text: string };

describe('parseHistorialRowDate', () => {
  it('parses DD/MM HH:MM from a real #11497 row', () => {
    expect(
      parseHistorialRowDate(
        '8821127182837 JENNY PENSOTTI Río Yi Manzana 669 Solar 8 Solymar Canelones 22/04 20:55',
      ),
    ).toEqual({ day: 22, month: 4, hour: 20, minute: 55 });
  });

  it('parses DD/MM with no time (defaults to 00:00)', () => {
    expect(
      parseHistorialRowDate(
        '8821166614737 NELLY SUSAN GARCIA MARTINICORENA 18 de Julio 199 Tacuarembo Tacuarembo 09/05',
      ),
    ).toEqual({ day: 9, month: 5, hour: 0, minute: 0 });
  });

  it('takes the LAST date token so an address fragment never shadows the dispatch date', () => {
    // "Ruta 8 km 22/04" address-ish fragment BEFORE the real trailing date.
    expect(
      parseHistorialRowDate('8821127199999 PEDRO GOMEZ Ruta 8 km 22/04 Canelones 09/05 11:20'),
    ).toEqual({ day: 9, month: 5, hour: 11, minute: 20 });
  });

  it('returns null when the row carries no date', () => {
    expect(parseHistorialRowDate('8821127180001 OTHER CUSTOMER Some Other Address')).toBeNull();
  });

  it('returns null for an out-of-range day or month', () => {
    expect(parseHistorialRowDate('8821127180001 X 40/04')).toBeNull();
    expect(parseHistorialRowDate('8821127180001 X 10/13')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseHistorialRowDate('')).toBeNull();
  });
});

describe('isHistorialRowRecent', () => {
  // 15 Mar 2026, 15:00 Montevideo (= 18:00Z).
  const attempt = new Date('2026-03-15T18:00:00Z');

  it('accepts a row stamped the same day as the attempt', () => {
    expect(isHistorialRowRecent('... Montevideo 15/03 14:30', attempt, 2)).toBe(true);
  });

  it('accepts a row stamped the same day with no time', () => {
    expect(isHistorialRowRecent('... Montevideo 15/03', attempt, 2)).toBe(true);
  });

  it('accepts a row one day either side (inside ±2d)', () => {
    expect(isHistorialRowRecent('... 14/03 09:00', attempt, 2)).toBe(true);
    expect(isHistorialRowRecent('... 16/03 23:00', attempt, 2)).toBe(true);
  });

  it('rejects a row well outside the window (old same-name shipment)', () => {
    expect(isHistorialRowRecent('... 25/04 10:00', attempt, 2)).toBe(false);
    expect(isHistorialRowRecent('... 05/03 10:00', attempt, 2)).toBe(false);
  });

  it('rejects an undateable row when a window is in force', () => {
    expect(isHistorialRowRecent('8821127180001 OTHER CUSTOMER no date here', attempt, 2)).toBe(false);
  });

  it('survives a Dec→Jan year boundary via adjacent-year probing', () => {
    const newYear = new Date('2026-01-01T12:00:00Z'); // 09:00 Montevideo, 1 Jan 2026
    expect(isHistorialRowRecent('... 31/12 21:00', newYear, 2)).toBe(true); // prev year
    expect(isHistorialRowRecent('... 02/01 03:00', newYear, 2)).toBe(true); // same year
  });
});

describe('recency gate + pickMatchingHistorialRow composition (what orphan-reconcile runs)', () => {
  const recipient = 'Maria Lopez';
  const dest = { city: 'Montevideo', department: 'Montevideo' };
  // Order was submitted 9 May 2026 ~08:20 Montevideo (= 11:20Z).
  const attempt = new Date('2026-05-09T11:20:00Z');

  const recentRow: Row = {
    guia: '8821166614740',
    href: 'https://www.dac.com.uy/envios/guiacreada/8821166614740',
    text: '8821166614740 MARIA LOPEZ 18 de Julio 100 Montevideo Montevideo 09/05 08:25',
  };
  // Same recipient + destination, but a shipment from two weeks earlier — the
  // poisoning trap. Its guía number is necessarily LOWER (DAC guías are
  // monotonic), but the gate must not even rely on that.
  const oldRow: Row = {
    guia: '8821166600000',
    href: null,
    text: '8821166600000 MARIA LOPEZ Av Brasil 200 Montevideo Montevideo 25/04 16:10',
  };

  const eligible = (rows: Row[]) =>
    rows.filter((r) => isHistorialRowRecent(r.text, attempt, 2));

  it('recovers a recent buried guía once the deeper scan reaches it', () => {
    const picked = pickMatchingHistorialRow(eligible([oldRow, recentRow]), recipient, [], dest);
    expect(picked?.guia).toBe('8821166614740');
  });

  it('REFUSES an old same-name+dest shipment that the gate filters out', () => {
    // Without the gate, name + destination both match → the old guía WOULD be
    // adopted (a poisoning). With the gate the only candidate is filtered, so
    // there is no match and the order safely stays parked / resets for retry.
    const withoutGate = pickMatchingHistorialRow([oldRow], recipient, [], dest);
    expect(withoutGate?.guia).toBe('8821166600000'); // proves the row matches name+dest

    const withGate = pickMatchingHistorialRow(eligible([oldRow]), recipient, [], dest);
    expect(withGate).toBeNull(); // the recency gate changed the outcome to "safe"
  });
});
