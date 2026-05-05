import { describe, it, expect } from 'vitest';
import { pickMatchingHistorialRow } from '../dac/shipment';

// Regression tests for the 2026-04-22 #11497 Jenny Pensotti incident.
//
// Background: after clicking Finalizar on the DAC form, the worker relies
// on the browser URL to decide whether DAC accepted or rejected the form:
//   - URL redirected to /envios/guiacreada/<id>  → accepted
//   - URL stayed on /envios/nuevo                → rejected
//
// The URL signal is NOT reliable. In the #11497 incident DAC created guía
// 8821127182837 for the customer Jenny Pensotti (Solymar, Canelones), then
// redirected the browser back to /envios/nuevo (DAC's "start a new
// shipment" flow). The worker interpreted the URL as rejection, threw
// DacAddressRejectedError, wrote a "dirección confusa" note on Shopify,
// and deleted the PendingShipment row. DAC still billed the tenant, the
// customer never got tracking, and the guía was orphaned in DAC.
//
// Fix: when the URL is /envios/nuevo but DAC shows no validation error,
// we now try a RESCUE historial lookup — scrape DAC's historial page and
// look for a row whose visible text matches the recipient name we filled
// on the form. If we find a single guía that (a) is not already in our DB
// and (b) has the customer's name in the row, we adopt it.
//
// Critical safety property: the rescue MUST NOT cause the older
// #11481 Noelia Osorio / 8821122926412 poisoning bug. That happened
// because the previous code picked "the newest guía in historial" with
// no filter — an unrelated guía from a manual DAC shipment got attributed
// to a rejected order. These tests lock in the name-match guard.

type Row = { guia: string; href: string | null; text: string };

describe('pickMatchingHistorialRow', () => {
  // ── Happy path: #11497 rescue ────────────────────────────────────────────
  describe('happy path — rescues a guía whose row matches recipient', () => {
    it('#11497 Jenny Pensotti — finds 8821127182837 when row text has full name', () => {
      const rows: Row[] = [
        {
          guia: '8821127182837',
          href: 'https://www.dac.com.uy/envios/guiacreada/8821127182837',
          text: '8821127182837 JENNY PENSOTTI Río Yi Manzana 669 Solar 8 Solymar Canelones 22/04 20:55',
        },
        {
          guia: '8821127180001',
          href: null,
          text: '8821127180001 OTHER CUSTOMER Some Other Address',
        },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Jenny Pensotti', []);
      expect(picked?.guia).toBe('8821127182837');
    });

    it('case- and accent-insensitive match', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PÉNSOTTI Some address' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'jenny pensotti', []);
      expect(picked?.guia).toBe('8821127182837');
    });

    it('matches when DAC displays name uppercase and we filled mixed case', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: 'ADRIANA ABEIJON 8821127182837 Juan Ortíz 3315 Apto 201 Montevideo' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Adriana Abeijon', []);
      expect(picked?.guia).toBe('8821127182837');
    });
  });

  // ── #11481 Noelia Osorio POISONING regression guard ─────────────────────
  describe('poisoning guard — must NOT match unrelated historial rows', () => {
    it('returns null when no row contains the recipient name', () => {
      const rows: Row[] = [
        // These are real-looking guías from other customers — what the old
        // blind "highest guía in historial" would have picked.
        { guia: '8821122926412', href: null, text: '8821122926412 CARLOS PEREZ Canelones' },
        { guia: '8821122926500', href: null, text: '8821122926500 MARIA LOPEZ Maldonado' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Noelia Osorio', []);
      expect(picked).toBeNull();
    });

    it('short/ambiguous names (<3 usable tokens) return null', () => {
      // "Ana Ri" — both tokens <3 chars after filtering. Refusing these
      // prevents matching any shipment where "Ana" appears in the row.
      const rows: Row[] = [
        { guia: '8821127100000', href: null, text: '8821127100000 ANALIA RIVERO anywhere' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Ana Ri', []);
      expect(picked).toBeNull();
    });

    it('empty recipient name returns null', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: 'any text with guía' },
      ];
      expect(pickMatchingHistorialRow(rows, '', [])).toBeNull();
      expect(pickMatchingHistorialRow(rows, '   ', [])).toBeNull();
    });

    it('only some of the name tokens matching is NOT enough', () => {
      // "Juan Perez" — if only "Juan" appears in a row (different
      // last name), we must NOT match. Both tokens are required.
      const rows: Row[] = [
        { guia: '8821127100000', href: null, text: '8821127100000 JUAN GONZALEZ somewhere' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Juan Perez', []);
      expect(picked).toBeNull();
    });

    it('guía already in our DB (excludeGuias) is not re-adopted', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PENSOTTI Solymar' },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Jenny Pensotti',
        ['8821127182837'],
      );
      expect(picked).toBeNull();
    });
  });

  // ── Multi-row: repeat customer ──────────────────────────────────────────
  describe('multiple matching rows — picks highest/newest guía', () => {
    it('repeat customer: picks the highest-numbered guía not in excludeGuias', () => {
      // Jenny ordered before (older guía is in our DB), then ordered again
      // (new guía not yet in our DB). The rescue should pick the newer one.
      const rows: Row[] = [
        { guia: '8821127100000', href: null, text: '8821127100000 JENNY PENSOTTI old shipment' },
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PENSOTTI new shipment' },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Jenny Pensotti',
        ['8821127100000'],
      );
      expect(picked?.guia).toBe('8821127182837');
    });

    it('when all matching guías are excluded, returns null', () => {
      const rows: Row[] = [
        { guia: '8821127100000', href: null, text: '8821127100000 JENNY PENSOTTI' },
        { guia: '8821127182837', href: null, text: '8821127182837 JENNY PENSOTTI' },
      ];
      const picked = pickMatchingHistorialRow(
        rows,
        'Jenny Pensotti',
        ['8821127100000', '8821127182837'],
      );
      expect(picked).toBeNull();
    });
  });

  // ── Empty/degenerate inputs ─────────────────────────────────────────────
  describe('degenerate inputs', () => {
    it('empty rows returns null', () => {
      expect(pickMatchingHistorialRow([], 'Jenny Pensotti', [])).toBeNull();
    });

    it('rows without any recipient-like text return null', () => {
      const rows: Row[] = [
        { guia: '8821127182837', href: null, text: '8821127182837 99.99' },
      ];
      const picked = pickMatchingHistorialRow(rows, 'Jenny Pensotti', []);
      expect(picked).toBeNull();
    });
  });
});
