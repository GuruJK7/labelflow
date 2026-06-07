// Pickup-at-DAC-branch recognition — load-bearing for two flows:
//   1. The missingStreetNumber pre-check: pickup-mode addresses skip the
//      AI feasibility call entirely (they don't need a number, the branch
//      is the destination).
//   2. The DAC Step-1 form fill: when this returns true, TipoEntrega
//      switches from "Domicilio" (home delivery) to "Agencia" (branch pickup).
//
// The 2026-05-11 incident that motivated this consolidation: orders like
//   - "DAC Barros blancos (retiro en agencia)" (Jenifer Sastre)
//   - "Sucursal de Dac Buceo" (Margarita De Mattos, #1200)
//   - "Dac Las Piedras" (Ezequiel Torres, #1170)
// were all being bounced to NEEDS_REVIEW because the AI feasibility check
// ran first and saw "no street number". The DAC submission code DID have
// pickup detection but it never got the chance to run.

import { describe, it, expect } from 'vitest';
import { isPickupAtDacBranch } from '../dac/shipment';

describe('isPickupAtDacBranch', () => {
  // ── Positive cases — these MUST trigger pickup mode ───────────────────

  it('detects "retiro en agencia" verbatim in address1', () => {
    expect(isPickupAtDacBranch('Retiro en agencia', '', '')).toBe(true);
  });

  it('detects "Retiro en DAC" (case-insensitive)', () => {
    expect(isPickupAtDacBranch('retiro en DAC', '', '')).toBe(true);
  });

  it('detects "retiro en sucursal"', () => {
    expect(isPickupAtDacBranch('retiro en sucursal', '', '')).toBe(true);
  });

  it('detects "retiro en local" / "retiro en oficina"', () => {
    expect(isPickupAtDacBranch('Retiro en local', '', '')).toBe(true);
    expect(isPickupAtDacBranch('retiro en oficina', '', '')).toBe(true);
  });

  it('detects bare "Retiro" as address1', () => {
    expect(isPickupAtDacBranch('Retiro', '', '')).toBe(true);
  });

  it('detects "DAC <ciudad>" pattern at start of address1 (Jenifer Sastre case)', () => {
    expect(isPickupAtDacBranch('DAC Barros Blancos', '', '')).toBe(true);
    expect(isPickupAtDacBranch('Dac Las Piedras', '', '')).toBe(true);
    expect(isPickupAtDacBranch('dac maldonado', '', '')).toBe(true);
  });

  it('detects "Sucursal de Dac <ciudad>" pattern (#1200 Margarita De Mattos case)', () => {
    expect(isPickupAtDacBranch('Sucursal de Dac Buceo', '', '')).toBe(true);
    expect(isPickupAtDacBranch('Sucursal Dac Pocitos', '', '')).toBe(true);
  });

  it('detects "Agencia DAC <ciudad>" pattern (#11878 Pinamar case)', () => {
    expect(isPickupAtDacBranch('Agencia DAC Pinamar', '', '')).toBe(true);
    expect(isPickupAtDacBranch('agencia de dac Salto', '', '')).toBe(true);
  });

  it('detects combined Jenifer Sastre case "DAC Barros blancos( retiro en agencia)"', () => {
    expect(isPickupAtDacBranch('DAC Barros blancos( retiro en agencia)', '', '')).toBe(true);
  });

  it('detects pickup info in address2 (when address1 is the recipient line)', () => {
    expect(isPickupAtDacBranch('Maria González', 'retiro en agencia', '')).toBe(true);
  });

  it('detects pickup info in order.note when address fields look normal', () => {
    expect(isPickupAtDacBranch('Av Italia 1234', '', 'Por favor retiro en agencia')).toBe(true);
  });

  it('detects English "pickup" anywhere', () => {
    expect(isPickupAtDacBranch('Cualquier cosa', '', 'note: pickup at DAC')).toBe(true);
  });

  // ── Negative cases — must NOT false-positive ──────────────────────────

  it('does NOT match a regular street address', () => {
    expect(isPickupAtDacBranch('Av Italia 5000', '', '')).toBe(false);
    expect(isPickupAtDacBranch('18 de Julio 1234', 'Apto 5B', '')).toBe(false);
  });

  it('does NOT match "DAC" as a word that happens to be a brand/keyword', () => {
    // "DAC" alone (no following city/word) → not pickup. The DAC-prefix
    // pattern requires a non-space char after "dac\s".
    expect(isPickupAtDacBranch('DAC', '', '')).toBe(false);
    expect(isPickupAtDacBranch('DAC ', '', '')).toBe(false);
  });

  it('does NOT match "agencia" without "dac" (precision — could be a business name)', () => {
    expect(isPickupAtDacBranch('Agencia de viajes Buquebus', '', '')).toBe(false);
    expect(isPickupAtDacBranch('Agencia 123', '', '')).toBe(false);
  });

  it('does NOT match street names containing "dac" as substring', () => {
    // Defensive — there is no real Uruguayan street named like this, but
    // we want to be sure our regex anchors to start-of-string.
    expect(isPickupAtDacBranch('Av Eduardo Lapidac 100', '', '')).toBe(false);
  });

  it('does NOT match if "retiro" is part of a larger word (not as a standalone)', () => {
    // Regex uses \b on /^retiro\b/i so embedded substrings shouldn't match.
    expect(isPickupAtDacBranch('Retiroso 100', '', '')).toBe(false);
  });

  it('handles null/undefined inputs without throwing', () => {
    expect(isPickupAtDacBranch(null, null, null)).toBe(false);
    expect(isPickupAtDacBranch(undefined, undefined, undefined)).toBe(false);
    expect(isPickupAtDacBranch(null, undefined, 'retiro en dac')).toBe(true);
  });

  it('handles empty strings without throwing', () => {
    expect(isPickupAtDacBranch('', '', '')).toBe(false);
  });
});
