// Last-mile no-door-number guard — regression for parked order #5380
// ("Santiago Fraga", Maldonado).
//
// Trail (live RunLog 2026-06-02): the customer's address was
//   "Barrio san fernando calle salsipuede edificio esperanza"  (NO door number)
//   + apartment "Apto 02" (which ended up in the DAC observations).
// DAC SILENTLY rejected at Finalizar (URL stayed /envios/nuevo, empty error
// box) because DirD carried a street with no door number.
//
// Why the upstream missingStreetNumber pre-check missed it: the apartment digit
// ("02") was present in the raw address at pre-check time, so the bare-digit
// branch of isAddressIncomplete saw a digit and — with no cross-street keyword —
// returned false. mergeAddress then stripped the apt into observations, leaving
// DirD with no number. The fix re-checks the FINAL merged DirD string and, when
// it still has no number, ships with "S/N" + an operator-call note (courier
// phones the customer) instead of letting DAC silently reject.
//
// These tests pin the discriminating pure logic (isAddressIncomplete on the
// real strings) and the merge behaviour that produces the no-number DirD.

import { describe, it, expect } from 'vitest';
import { isAddressIncomplete } from '../dac/address-cleanup';
import { mergeAddress } from '../dac/shipment';

describe('#5380 no-door-number detection', () => {
  it('flags the FINAL merged DirD string (no door number) as incomplete', () => {
    // Exact string DirD received per the trail's "Merged address:" log.
    expect(isAddressIncomplete('Barrio san fernando calle salsipuede edificio esperanza')).toBe(true);
  });

  it('documents the pre-check false-negative: an apartment digit hides the missing door number', () => {
    // With the apt "02" still attached, the bare-digit branch sees a digit and
    // (because there is no esquina/entre/casi cross-street keyword) returns
    // false — this is exactly why the upstream guard skipped #5380.
    expect(isAddressIncomplete('Barrio san fernando calle salsipuede edificio esperanza apto 02')).toBe(false);
  });

  it('mergeAddress moves the apt out of DirD, so the final DirD is correctly seen as incomplete', () => {
    const merged = mergeAddress('Barrio san fernando calle salsipuede edificio esperanza', 'Apto 02');
    // The apt belongs in observations, not in the street field…
    expect(merged.extraObs.toLowerCase()).toContain('02');
    // …leaving DirD with no door number → the last-mile guard must fire.
    expect(isAddressIncomplete(merged.fullAddress)).toBe(true);
  });

  it('does NOT fire for a real street address that merely has an apartment', () => {
    const merged = mergeAddress('Av Italia 1234', 'Apto 5');
    // Door number 1234 stays in DirD → guard must NOT fire (no S/N, no note).
    expect(isAddressIncomplete(merged.fullAddress)).toBe(false);
  });
});
