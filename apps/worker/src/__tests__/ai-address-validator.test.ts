// Tests for the proactive AI address consistency validator
// (apps/worker/src/dac/ai-address-validator.ts).
//
// Background — 2026-05-11 silent-reject incidents:
//   • #12001 Esmeralda P  — city="Aires puros" province="Montevideo" zip="11200"
//   • #12002 Liria Pouso  — city="Pando"       province="Montevideo" zip="15600"
//
// Both addresses passed the deterministic city→dept resolver with HIGH
// confidence (Aires Puros IS in MVD, Pando IS a real Uruguay city) so
// neither ai-feasibility nor ai-resolver fired, and DAC silently rejected
// the inconsistent (city, province, zip) tuples without showing an error.
//
// validateAddressConsistency runs PROACTIVELY before every DAC submit.
// These tests pin the validator's behaviour around:
//
//   1. The output shape coercion (Claude can emit malformed JSON; we
//      must never crash, and we must never auto-apply corrections
//      that look wrong).
//   2. The "skip on no inputs" early-return.
//   3. The integration contract — caller is allowed to mutate addr in
//      place only when confidence='high' AND corrections has a valid
//      dept (in VALID_DEPARTMENTS) and/or 4–5 digit zip.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateAddressConsistency,
  type AddressValidationInput,
  type AddressValidationResult,
} from '../dac/ai-address-validator';

// We mock the bridge helper so unit tests don't make HTTP calls. Each
// test sets the bridge's "next return value" to exercise the various
// branches the coercion code handles. Mock functions are vi.hoisted()
// so they exist at the module-eval time of the mock factory (vi.mock
// is hoisted ABOVE the imports by vitest's transformer).
const { mockBridge, mockApiCreate } = vi.hoisted(() => ({
  mockBridge: vi.fn(),
  mockApiCreate: vi.fn(),
}));

vi.mock('../agent/claude-call', () => ({
  callClaudeJSONViaBridge: mockBridge,
}));
// Also mock the Anthropic SDK so the API-fallback path doesn't actually
// dial home. The mockApiCreate is the SHARED messages.create across all
// `new Anthropic()` instances, so the validator's own `new Anthropic(...)`
// call hits this mock just like our test-local one.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: mockApiCreate };
  },
}));
// DB writes are fire-and-forget. Stub so test runs don't try to reach
// Postgres. The validator only awaits a .catch() chain so a no-op
// resolved promise is sufficient.
vi.mock('../db', () => ({
  db: {
    runLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

const bridgeMock = mockBridge;

const baseInput: AddressValidationInput = {
  tenantId: 'tenant-test',
  orderName: '#TEST-1',
  address1: 'Lavalleja N° 736 casi Laurnaga',
  city: 'Pando',
  province: 'Montevideo',
  zip: '15600',
  country: 'Uruguay',
};

beforeEach(() => {
  bridgeMock.mockReset();
  mockApiCreate.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateAddressConsistency — early skip guards', () => {
  it('skips when address1 is empty (no useful signal)', async () => {
    const r = await validateAddressConsistency({ ...baseInput, address1: '' });
    expect(r.skipped).toBe(true);
    expect(r.consistent).toBe(true); // safe default: caller proceeds
    expect(r.transport).toBe('skipped');
    expect(bridgeMock).not.toHaveBeenCalled();
  });

  it('skips when city is empty', async () => {
    const r = await validateAddressConsistency({ ...baseInput, city: '' });
    expect(r.skipped).toBe(true);
    expect(r.transport).toBe('skipped');
    expect(bridgeMock).not.toHaveBeenCalled();
  });
});

describe('validateAddressConsistency — bridge happy path', () => {
  it('returns consistent=true with no corrections when Claude agrees', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: true,
      corrections: null,
      confidence: 'high',
      issues: [],
    });
    const r = await validateAddressConsistency({
      ...baseInput,
      city: 'Cordón',
      province: 'Montevideo',
      zip: '11200',
    });
    expect(r.skipped).toBe(false);
    expect(r.consistent).toBe(true);
    expect(r.corrections).toBeNull();
    expect(r.transport).toBe('bridge');
    expect(r.aiCostUsd).toBe(0);
  });

  it('the #12002 Pando/MVD/15600 case — auto-correctable with high confidence', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Canelones', zip: '91000' },
      confidence: 'high',
      issues: [
        'pando está en canelones, no montevideo',
        'zip 15600 no corresponde a pando',
      ],
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.consistent).toBe(false);
    expect(r.confidence).toBe('high');
    expect(r.corrections).toEqual({ department: 'Canelones', zip: '91000' });
    expect(r.issues).toHaveLength(2);
    expect(r.transport).toBe('bridge');
  });

  it('the #12001 Aires Puros borderline — medium confidence is NOT auto-applied', async () => {
    // Claude says zip 11200 (Cordón) doesn't match Aires Puros (~11700)
    // but both are in MVD so DAC should still accept. Confidence=medium.
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { zip: '11700' },
      confidence: 'medium',
      issues: ['zip 11200 corresponds to cordón; aires puros expected ~11700'],
    });
    const r = await validateAddressConsistency({
      ...baseInput,
      city: 'Aires Puros',
      province: 'Montevideo',
      zip: '11200',
    });
    expect(r.consistent).toBe(false);
    expect(r.confidence).toBe('medium');
    // The caller's policy (in shipment.ts) only auto-applies on high
    // confidence — but the corrections payload should still come back
    // so the caller can log it for the operator.
    expect(r.corrections).toEqual({ zip: '11700' });
  });
});

describe('validateAddressConsistency — defensive coercion of malformed Claude output', () => {
  it('rejects a non-object response and returns safe-default consistent=true', async () => {
    bridgeMock.mockResolvedValueOnce('not an object');
    // Non-object string fails the `typeof bridgeRaw === 'object'` check
    // so the validator falls to the API path. Make API also fail; the
    // validator must then return consistent=true so the caller proceeds
    // with the original address.
    mockApiCreate.mockRejectedValueOnce(new Error('test'));
    const r = await validateAddressConsistency(baseInput);
    expect(r.consistent).toBe(true);
  });

  it('drops unknown department names (rejects hallucinations)', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      // "Atlantis" is not a Uruguay department — must be dropped.
      corrections: { department: 'Atlantis', zip: '91000' },
      confidence: 'high',
      issues: ['city in wrong dept'],
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.corrections).toEqual({ zip: '91000' }); // dept dropped, zip kept
  });

  it('drops non-numeric or wrong-length zips', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Canelones', zip: 'NOT-A-ZIP' },
      confidence: 'high',
      issues: ['bad data'],
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.corrections).toEqual({ department: 'Canelones' }); // zip dropped
  });

  it('drops corrections payload entirely when neither field is valid', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Mars', zip: '123' },
      confidence: 'high',
      issues: [],
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.corrections).toBeNull();
  });

  it('clamps confidence to a known value (rejects "very-high" hallucinations)', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Canelones' },
      confidence: 'very-high',
      issues: [],
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.confidence).toBe('none'); // unknown → 'none' so caller treats as low-trust
  });

  it('truncates issues array to 8 entries (DoS guard)', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: null,
      confidence: 'medium',
      issues: Array.from({ length: 50 }, (_, i) => `issue ${i}`),
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.issues).toHaveLength(8);
  });

  it('strips non-string entries from issues array', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: null,
      confidence: 'low',
      issues: ['real issue', 123, null, { obj: true }, 'other issue'],
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.issues).toEqual(['real issue', 'other issue']);
  });
});

describe('validateAddressConsistency — fallback behaviour', () => {
  it('NEVER throws — bridge throw + no API key produces safe skipped result', async () => {
    bridgeMock.mockRejectedValueOnce(new Error('bridge died'));
    delete process.env.ANTHROPIC_API_KEY;
    const r = await validateAddressConsistency(baseInput);
    expect(r.skipped).toBe(true);
    expect(r.consistent).toBe(true);
    expect(r.transport).toBe('skipped');
  });

  it('falls back to API when bridge returns null', async () => {
    bridgeMock.mockResolvedValueOnce(null);
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    mockApiCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '{"consistent": false, "corrections": { "department": "Canelones" }, "confidence": "high", "issues": ["pando is in canelones"]}',
        },
      ],
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    const r = await validateAddressConsistency(baseInput);
    expect(r.transport).toBe('api');
    expect(r.consistent).toBe(false);
    expect(r.corrections).toEqual({ department: 'Canelones' });
    expect(r.aiCostUsd).toBeGreaterThan(0);
  });

  it('handles API returning unparseable JSON without crashing', async () => {
    bridgeMock.mockResolvedValueOnce(null);
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    mockApiCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sorry I cannot help' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.skipped).toBe(true);
    expect(r.consistent).toBe(true);
    expect(r.transport).toBe('api');
  });

  it('strips ```json fences around API response (forgiving parser)', async () => {
    bridgeMock.mockResolvedValueOnce(null);
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    mockApiCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '```json\n{"consistent": true, "corrections": null, "confidence": "high", "issues": []}\n```',
        },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.consistent).toBe(true);
  });
});

describe('validateAddressConsistency — 2026-05-11 directive-style corrections (operator request)', () => {
  // The operator explicitly asked: "no solo digas confidence baja" — when
  // the input has a clear inconsistency the validator should DECIDE and
  // CORRECT, not punt. These tests pin the contract for the
  // higher-aggression cases we expect haiku to handle with the new prompt.

  it('CITY IS A MVD BARRIO mistyped as another dept → corrects to Montevideo (high)', async () => {
    // Customer typed "Aires Puros" (which is a MVD barrio) but selected
    // Canelones as province. Claude must recognize the barrio and correct.
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Montevideo' },
      confidence: 'high',
      issues: ['aires puros es un barrio de montevideo no canelones'],
    });
    const r = await validateAddressConsistency({
      ...baseInput,
      city: 'Aires Puros',
      province: 'Canelones',
      zip: '11700',
    });
    expect(r.consistent).toBe(false);
    expect(r.confidence).toBe('high');
    expect(r.corrections).toEqual({ department: 'Montevideo' });
  });

  it('AMBIGUOUS but ZIP disambiguates → high confidence (not low)', async () => {
    // San José could be the dept capital or a MVD barrio. ZIP 80000 is
    // San José dept territory → high confidence. Claude returns the
    // accented Spanish spelling; the coercion canonicalises it to
    // VALID_DEPARTMENTS' accent-free form ("San Jose").
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'San José' },
      confidence: 'high',
      issues: ['zip 80000 corresponde a san josé depto'],
    });
    const r = await validateAddressConsistency({
      ...baseInput,
      city: 'San José',
      province: 'Montevideo',
      zip: '80000',
    });
    expect(r.confidence).toBe('high');
    // Canonical form (matches VALID_DEPARTMENTS), not the accented Spanish
    // form Claude returned.
    expect(r.corrections?.department).toBe('San Jose');
  });

  it('accent normalization — Claude returns "Paysandú" → canonicalised to "Paysandu"', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Paysandú' },
      confidence: 'high',
      issues: ['city corresponds to paysandu dept'],
    });
    const r = await validateAddressConsistency({
      ...baseInput,
      city: 'Quebracho',
      province: 'Salto',
      zip: '60100',
    });
    expect(r.corrections?.department).toBe('Paysandu');
  });

  it('accent normalization — "Río Negro" canonicalised to "Rio Negro"', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Río Negro' },
      confidence: 'high',
      issues: ['fray bentos is rio negro'],
    });
    const r = await validateAddressConsistency({
      ...baseInput,
      city: 'Fray Bentos',
      province: 'Colonia',
      zip: '65000',
    });
    expect(r.corrections?.department).toBe('Rio Negro');
  });

  it('accent normalization — "Tacuarembó" canonicalised to "Tacuarembo"', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Tacuarembó' },
      confidence: 'high',
      issues: ['city in tacuarembo dept'],
    });
    const r = await validateAddressConsistency({
      ...baseInput,
      city: 'Paso de los Toros',
      province: 'Rivera',
      zip: '45000',
    });
    expect(r.corrections?.department).toBe('Tacuarembo');
  });

  it('Atlántida (a Canelones beach town typed as Maldonado) → high confidence Canelones', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: false,
      corrections: { department: 'Canelones' },
      confidence: 'high',
      issues: ['atlántida es de canelones no maldonado'],
    });
    const r = await validateAddressConsistency({
      ...baseInput,
      city: 'Atlántida',
      province: 'Maldonado',
      zip: '15500',
    });
    expect(r.confidence).toBe('high');
    expect(r.corrections).toEqual({ department: 'Canelones' });
  });
});

describe('validateAddressConsistency — observability contract', () => {
  it('cost is 0 on bridge success', async () => {
    bridgeMock.mockResolvedValueOnce({
      consistent: true,
      corrections: null,
      confidence: 'high',
      issues: [],
    });
    const r = await validateAddressConsistency(baseInput);
    expect(r.aiCostUsd).toBe(0);
    expect(r.transport).toBe('bridge');
  });
});
