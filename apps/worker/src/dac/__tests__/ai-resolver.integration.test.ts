/**
 * AI Resolver integration test (vitest wrapper).
 *
 * This is a thin wrapper around the standalone runner in
 * scripts/run-resolver-suite.ts. It exists to make the suite discoverable
 * by `vitest` and to expose one assertion per fixture for IDE/CI reporting.
 *
 * The real workhorse — fixture loading, DB mocking, report generation — lives
 * in the runner. This file only:
 *
 *   1. Skips entirely when ANTHROPIC_API_KEY is not set (vitest unit runs).
 *   2. Loads fixtures from scripts/resolver-fixtures.json.
 *   3. Runs each fixture via the shared harness and asserts PASS/GAP.
 *
 * To run:
 *   ANTHROPIC_API_KEY=sk-ant-... npx vitest run src/dac/__tests__/ai-resolver.integration.test.ts
 *
 * Or (preferred) use the standalone runner which also writes the markdown report:
 *   npx ts-node scripts/run-resolver-suite.ts
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../../db';
import {
  resolveAddressWithAI,
  AIResolverInput,
  AIResolverResult,
  VALID_DEPARTMENTS,
} from '../ai-resolver';

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const FIXTURES_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'resolver-fixtures.json');

// ─── in-place DB mock (same strategy as the standalone runner) ─────────────

let currentHistory: Array<{ department: string; city: string; deliveryAddress: string }> = [];

(db.label as any) = {
  findMany: async () => currentHistory,
};
(db.addressResolution as any) = {
  findUnique: async () => null,
  upsert: async () => ({}),
  update: async () => ({}),
};
(db.tenant as any) = {
  findUnique: async () => ({
    aiResolverEnabled: true,
    aiResolverDailyLimit: 10000,
    aiResolverDailyUsed: 0,
  }),
  update: async () => ({}),
  updateMany: async () => ({ count: 0 }),
};

// ─── fixture loader ────────────────────────────────────────────────────────

interface Fixture {
  id: string;
  category: string;
  description: string;
  input: {
    city: string;
    address1: string;
    address2: string;
    zip: string;
    province: string;
    country: string;
    customerFirstName: string;
    customerLastName: string;
    customerEmail: string;
    customerPhone: string;
    orderNotes: string;
  };
  expected: {
    department: string;
    barrio: string | null;
    minConfidence: 'high' | 'medium' | 'low';
    allowNull?: boolean;
  };
  customerHistory?: Array<{ department: string; city: string; deliveryAddress: string }>;
  source: string;
}

function loadFixtures(): Fixture[] {
  if (!fs.existsSync(FIXTURES_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  return raw.fixtures as Fixture[];
}

// ─── the suite ─────────────────────────────────────────────────────────────

const fixtures = loadFixtures();

describe.skipIf(!HAS_API_KEY)('AI resolver — full integration suite (live Anthropic API)', () => {
  it.each(fixtures)(
    '$id [$category] $description',
    async (fx) => {
      currentHistory = fx.customerHistory ?? [];

      const input: AIResolverInput = {
        tenantId: 'vitest-suite',
        ...fx.input,
      };

      const result: AIResolverResult | null = await resolveAddressWithAI(input);

      // Documented gap: some fixtures allow a null resolution (category K).
      if (fx.expected.allowNull && result === null) {
        return;
      }

      expect(result).not.toBeNull();
      if (!result) return; // satisfies ts after the assertion
      expect(result.department).toBe(fx.expected.department);

      if (fx.expected.barrio !== null && fx.expected.barrio !== undefined) {
        expect((result.barrio ?? '').toLowerCase()).toBe(fx.expected.barrio.toLowerCase());
      }

      const order = { low: 0, medium: 1, high: 2 };
      expect(order[result.confidence]).toBeGreaterThanOrEqual(order[fx.expected.minConfidence]);
    },
    /* per-test timeout */ 45_000,
  );
});

// When the API key is missing, at least assert fixtures loaded so the file
// is not silently empty in CI reports.
describe('AI resolver — fixture file integrity (no API)', () => {
  it('loads at least 100 fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(100);
  });

  it('every fixture has a department in the whitelist', () => {
    for (const fx of fixtures) {
      expect(VALID_DEPARTMENTS).toContain(fx.expected.department);
    }
  });
});
