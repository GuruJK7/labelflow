import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Audit 2026-05-06 — AI feasibility regression tests.
 *
 * The actual Anthropic API client is mocked; these tests lock in:
 *   - The shape of FeasibilityInput / FeasibilityResult
 *   - Behavior when ANTHROPIC_API_KEY is missing (fail-safe default)
 *   - Behavior when API call fails after retries (fail-safe default)
 *   - Mapping from Claude tool_use response → FeasibilityResult
 *   - Cost reporting from the response usage block
 *
 * We do NOT make real Claude calls in tests — that would be slow,
 * flaky, and require an API key in CI. The mock simulates the parts
 * of the SDK we depend on.
 */

const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockMessagesCreate };
      constructor(_opts: unknown) {}
    },
  };
});

import { assessAddressFeasibility, FeasibilityInput } from '../dac/ai-feasibility';

const baseInput: FeasibilityInput = {
  reason: 'no-street-number',
  tenantId: 'tenant-test',
  orderName: '#11724',
  customerName: 'Marcela Pascal',
  customerEmail: 'marcelapascal@gmail.com',
  customerPhone: '+598 98 871 923',
  city: 'La Paloma',
  address1: 'La Paloma',
  province: 'Rocha',
  zip: '27001',
  country: 'UY',
};

function mockAiResponse(toolInput: Record<string, unknown>) {
  mockMessagesCreate.mockResolvedValueOnce({
    content: [
      {
        type: 'tool_use',
        name: 'address_feasibility_verdict',
        input: toolInput,
      },
    ],
    usage: {
      input_tokens: 200,
      output_tokens: 50,
    },
  });
}

describe('assessAddressFeasibility', () => {
  beforeEach(() => {
    mockMessagesCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'sk-test-mock';
  });

  describe('returns unavailable when ANTHROPIC_API_KEY missing', () => {
    it('shippable=false, source=unavailable', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const result = await assessAddressFeasibility(baseInput);
      expect(result.shippable).toBe(false);
      expect(result.source).toBe('unavailable');
      expect(result.reasoning).toContain('ANTHROPIC_API_KEY');
      // Importantly: no call to Anthropic was attempted
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });
  });

  describe('happy path — AI says shippable with repair', () => {
    it('returns shippable=true with suggestedAddress1 when AI extracts the number from notes', async () => {
      mockAiResponse({
        shippable: true,
        confidence: 'high',
        reasoning: 'Customer wrote "La Paloma" but order.notes says "Calle del Mar 245".',
        suggestedAddress1: 'Calle del Mar 245',
        suggestedCity: '',
        operatorQuestion: '',
      });
      const result = await assessAddressFeasibility({
        ...baseInput,
        orderNotes: 'Mi dirección es Calle del Mar 245, frente a la plaza',
      });
      expect(result.shippable).toBe(true);
      expect(result.confidence).toBe('high');
      expect(result.suggestedAddress1).toBe('Calle del Mar 245');
      expect(result.source).toBe('ai');
      expect(result.aiCostUsd).toBeGreaterThan(0);
    });
  });

  describe('happy path — AI says NOT shippable with operator question', () => {
    it('returns shippable=false with operatorQuestion in Spanish', async () => {
      mockAiResponse({
        shippable: false,
        confidence: 'high',
        reasoning: 'Customer wrote only "La Paloma" with no street, number, or landmark.',
        suggestedAddress1: '',
        suggestedCity: '',
        operatorQuestion: 'Por favor confirme el nombre completo de la calle y el número de puerta donde recibirá el envío.',
      });
      const result = await assessAddressFeasibility(baseInput);
      expect(result.shippable).toBe(false);
      expect(result.confidence).toBe('high');
      expect(result.operatorQuestion).toContain('calle');
      expect(result.operatorQuestion).toContain('número');
      expect(result.suggestedAddress1).toBe('');
      expect(result.source).toBe('ai');
    });
  });

  describe('AI suggests a different city when typed city is wrong', () => {
    it('returns shippable=true with suggestedCity', async () => {
      mockAiResponse({
        shippable: true,
        confidence: 'high',
        reasoning: 'City "Mvdo" is the customer abbreviation for Montevideo.',
        suggestedAddress1: '',
        suggestedCity: 'Montevideo',
        operatorQuestion: '',
      });
      const result = await assessAddressFeasibility({
        ...baseInput,
        city: 'Mvdo',
        province: 'Montevideo',
        address1: 'Calle Test 100',
      });
      expect(result.shippable).toBe(true);
      expect(result.suggestedCity).toBe('Montevideo');
      expect(result.suggestedAddress1).toBe('');
    });
  });

  describe('dac-silent-reject flow', () => {
    it('passes attempted dept/city/barrio in the prompt', async () => {
      mockAiResponse({
        shippable: true,
        confidence: 'medium',
        reasoning: 'Address looks valid; DAC may have rate-limited or transient form bug.',
        suggestedAddress1: '',
        suggestedCity: '',
        operatorQuestion: '',
      });
      const result = await assessAddressFeasibility({
        ...baseInput,
        reason: 'dac-silent-reject',
        attemptedDept: 'Rocha',
        attemptedCity: 'La Paloma',
        attemptedBarrio: undefined,
      });
      expect(result.shippable).toBe(true);
      expect(result.confidence).toBe('medium');
      // Verify the user message contained the attempted values
      const callArgs = mockMessagesCreate.mock.calls[0]?.[0];
      const userMsg = callArgs?.messages?.[0]?.content as string;
      // The buildUserMessage uses Spanish-friendly labels for the prompt
      expect(userMsg).toContain('LO QUE INTENTAMOS EN DAC');
      expect(userMsg).toContain('Rocha');
      expect(userMsg).toContain('La Paloma');
    });
  });

  describe('error handling', () => {
    it('returns unavailable when API call throws non-retryable error', async () => {
      mockMessagesCreate.mockRejectedValueOnce(
        Object.assign(new Error('Bad request'), { status: 400 }),
      );
      const result = await assessAddressFeasibility(baseInput);
      expect(result.shippable).toBe(false);
      expect(result.source).toBe('unavailable');
      expect(result.reasoning).toContain('failed');
    });

    it('returns unavailable when response has no tool_use', async () => {
      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'I refuse to answer.' }],
        usage: { input_tokens: 100, output_tokens: 10 },
      });
      const result = await assessAddressFeasibility(baseInput);
      expect(result.shippable).toBe(false);
      expect(result.source).toBe('unavailable');
      expect(result.reasoning).toContain('tool not invoked');
    });
  });

  describe('user message construction', () => {
    it('includes all order context fields', async () => {
      mockAiResponse({
        shippable: true,
        confidence: 'high',
        reasoning: 'ok',
        suggestedAddress1: '',
        suggestedCity: '',
        operatorQuestion: '',
      });
      await assessAddressFeasibility({
        ...baseInput,
        orderNotes: 'Test notes here',
      });
      const callArgs = mockMessagesCreate.mock.calls[0]?.[0];
      const userMsg = callArgs?.messages?.[0]?.content as string;
      expect(userMsg).toContain('#11724');
      expect(userMsg).toContain('Marcela Pascal');
      expect(userMsg).toContain('marcelapascal@gmail.com');
      expect(userMsg).toContain('La Paloma');
      expect(userMsg).toContain('Rocha');
      expect(userMsg).toContain('27001');
      expect(userMsg).toContain('Test notes here');
    });

    it('uses the no-street-number reason in the prompt', async () => {
      mockAiResponse({
        shippable: false,
        confidence: 'high',
        reasoning: 'no number',
        suggestedAddress1: '',
        suggestedCity: '',
        operatorQuestion: 'Por favor confirme la calle y número.',
      });
      await assessAddressFeasibility(baseInput);
      const callArgs = mockMessagesCreate.mock.calls[0]?.[0];
      const userMsg = callArgs?.messages?.[0]?.content as string;
      expect(userMsg).toContain('no-street-number');
    });
  });

  describe('cost calculation', () => {
    it('reports a positive cost when AI call succeeds', async () => {
      mockAiResponse({
        shippable: true,
        confidence: 'high',
        reasoning: 'ok',
        suggestedAddress1: '',
        suggestedCity: '',
        operatorQuestion: '',
      });
      const result = await assessAddressFeasibility(baseInput);
      expect(result.aiCostUsd).toBeGreaterThan(0);
      // Sanity bound: under $0.01 for a small Haiku call
      expect(result.aiCostUsd).toBeLessThan(0.01);
    });
  });
});
