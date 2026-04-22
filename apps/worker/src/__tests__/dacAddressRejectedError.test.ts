import { describe, it, expect } from 'vitest';
import { DacAddressRejectedError, DuplicateSubmitError } from '../dac/shipment';

// 2026-04-22 post-run audit
//
// When DAC rejects the shipment form silently (URL stays on /envios/nuevo
// after clicking Finalizar) we throw DacAddressRejectedError so the job
// layer can: (a) tag the Label as NEEDS_REVIEW instead of FAILED, and
// (b) write a Spanish operator-friendly note on the Shopify order asking
// the operator to contact the customer to fix the address.
//
// The tests below lock in the error class contract so downstream
// `instanceof` checks in process-orders.job.ts and agent-bulk-upload.job.ts
// don't silently regress if someone refactors shipment.ts.

describe('DacAddressRejectedError — address-rejected-by-DAC error class', () => {
  it('is an instance of Error (so default error handling keeps working)', () => {
    const err = new DacAddressRejectedError('msg', '#11481');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DacAddressRejectedError);
  });

  it('carries the Shopify order name for audit / Shopify note composition', () => {
    const err = new DacAddressRejectedError('DAC rejected form', '#11481');
    expect(err.orderName).toBe('#11481');
  });

  it('exposes the isDacAddressRejected brand flag (useful for logs / metrics)', () => {
    const err = new DacAddressRejectedError('DAC rejected form', '#11481');
    expect(err.isDacAddressRejected).toBe(true);
  });

  it('sets err.name so logs show DacAddressRejectedError (not generic Error)', () => {
    const err = new DacAddressRejectedError('msg', '#100');
    expect(err.name).toBe('DacAddressRejectedError');
  });

  it('preserves the message so the existing error-log path is unchanged', () => {
    const msg =
      'DAC rejected the shipment form for #11481 (URL stayed on /envios/nuevo and no guía was extracted). ' +
      'Likely cause: address could not be classified into a valid department/barrio. Review the customer address in Shopify.';
    const err = new DacAddressRejectedError(msg, '#11481');
    expect(err.message).toBe(msg);
  });

  // Symmetry check — DuplicateSubmitError and DacAddressRejectedError are
  // both narrow error classes thrown from shipment.ts. The job catch block
  // relies on them being DISTINCT classes so it can write different
  // Shopify notes for each. A refactor that accidentally makes one extend
  // the other would silently break routing.
  it('is NOT confused with DuplicateSubmitError', () => {
    const addr = new DacAddressRejectedError('x', '#1');
    const dupe = new DuplicateSubmitError('y', 'PENDING', null);
    expect(addr).not.toBeInstanceOf(DuplicateSubmitError);
    expect(dupe).not.toBeInstanceOf(DacAddressRejectedError);
  });

  it('is catchable as a plain Error (backwards-compat for callers that do `catch (err)` without narrowing)', () => {
    const thrown = () => {
      throw new DacAddressRejectedError('x', '#1');
    };
    expect(thrown).toThrowError(/x/);
    try {
      thrown();
    } catch (err) {
      expect((err as Error).message).toBe('x');
      expect(err instanceof DacAddressRejectedError).toBe(true);
    }
  });

  // ─── dacErrorText — scraped DAC validation text ──────────────────────
  // 2026-04-22 — the catch-all "dirección confusa" message was misleading
  // when the real DAC rejection was something else (bad ZIP, missing
  // barrio, invalid phone length). We now scrape the DAC error box and
  // pass it through the error so the Shopify note shows the actual
  // reason. Tests below lock in that contract.

  it('defaults dacErrorText to empty string when not provided (backwards-compat)', () => {
    const err = new DacAddressRejectedError('msg', '#1');
    expect(err.dacErrorText).toBe('');
  });

  it('carries the scraped DAC validation text when provided', () => {
    const err = new DacAddressRejectedError(
      'DAC rejected form',
      '#11481',
      'El código postal no es válido para la localidad seleccionada.',
    );
    expect(err.dacErrorText).toBe(
      'El código postal no es válido para la localidad seleccionada.',
    );
  });

  it('dacErrorText is accessible via instanceof narrowing (so job-level catch can read it)', () => {
    const err: unknown = new DacAddressRejectedError('msg', '#1', 'Barrio obligatorio');
    if (err instanceof DacAddressRejectedError) {
      expect(err.dacErrorText).toBe('Barrio obligatorio');
    } else {
      throw new Error('instanceof narrowing failed — contract regression');
    }
  });
});
