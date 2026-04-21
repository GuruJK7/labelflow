/**
 * AI Resolver integration suite runner.
 *
 * Runs the real `resolveAddressWithAI` function against 117 hand-curated
 * Uruguayan addresses, with Prisma mocked in-place so nothing hits the DB.
 * The Anthropic API call IS real — this measures actual model accuracy +
 * cost, including any web_search tool usage.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx ts-node scripts/run-resolver-suite.ts
 *   npx ts-node scripts/run-resolver-suite.ts --dry-run=5
 *   npx ts-node scripts/run-resolver-suite.ts --category=B
 *
 * Outputs:
 *   scripts/resolver-suite-results.json   — per-fixture raw results
 *   RESOLVER_AUDIT_REPORT.md              — human-readable audit report
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db } from '../src/db';
import {
  resolveAddressWithAI,
  AIResolverInput,
  AIResolverResult,
  VALID_MVD_BARRIOS,
  VALID_DEPARTMENTS,
} from '../src/dac/ai-resolver';

// ─── types ──────────────────────────────────────────────────────────────────

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

interface FixtureResult {
  id: string;
  category: string;
  description: string;
  input: Fixture['input'];
  expected: Fixture['expected'];
  actual: {
    department: string | null;
    barrio: string | null;
    confidence: string | null;
    reasoning: string | null;
    deliveryAddress: string | null;
    extraObservations: string | null;
    rejected: boolean;
  };
  verdict: 'PASS' | 'FAIL' | 'GAP';
  verdictReason: string;
  latencyMs: number;
  costUsd: number;
  usedHistory: number;
  webSearches: number;
  cacheHit: boolean;
  error?: string;
}

// ─── mock DB (in-place) ─────────────────────────────────────────────────────
//
// The resolver imports the Prisma singleton from ../db. We replace its
// namespaced methods with deterministic fakes so nothing hits Postgres.
// `currentHistory` is swapped per-fixture before each call.

let currentHistory: Fixture['customerHistory'] = [];

(db.label as any) = {
  findMany: async () =>
    (currentHistory ?? []).map((h) => ({
      department: h.department,
      city: h.city,
      deliveryAddress: h.deliveryAddress,
    })),
};

(db.addressResolution as any) = {
  // Never return a cache hit — we want to measure the live model, not stale cache.
  findUnique: async () => null,
  // Persist is a no-op so nothing lands in prod DB.
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

// ─── harness ────────────────────────────────────────────────────────────────

const TENANT_ID = 'test-tenant-suite';

function argFlag(name: string): string | null {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw ? raw.split('=', 2)[1] : null;
}

function normBarrio(b: string | null | undefined): string {
  return (b ?? '').toLowerCase().trim();
}

function normDept(d: string | null | undefined): string {
  // Department whitelist is canonical — we compare exact.
  return (d ?? '').trim();
}

function verdictFor(fx: Fixture, actual: FixtureResult['actual']): { v: FixtureResult['verdict']; why: string } {
  // Rejected by resolver (returned null)
  if (actual.rejected) {
    if (fx.expected.allowNull) {
      return { v: 'GAP', why: 'Resolver returned null — documented gap (allowNull=true)' };
    }
    return { v: 'FAIL', why: 'Resolver returned null (rejected) but fixture expected a resolution' };
  }

  const expDept = normDept(fx.expected.department);
  const actDept = normDept(actual.department ?? '');
  if (expDept !== actDept) {
    return {
      v: 'FAIL',
      why: `department mismatch: expected "${expDept}", got "${actDept}"`,
    };
  }

  // Only enforce barrio when the fixture specifies one.
  if (fx.expected.barrio !== null && fx.expected.barrio !== undefined) {
    const expB = normBarrio(fx.expected.barrio);
    const actB = normBarrio(actual.barrio);
    if (expB !== actB) {
      return {
        v: 'FAIL',
        why: `barrio mismatch: expected "${expB}", got "${actB}"`,
      };
    }
  }

  // Confidence floor
  const order = { low: 0, medium: 1, high: 2 } as const;
  const minC = fx.expected.minConfidence;
  const actC = (actual.confidence ?? 'low').toLowerCase() as keyof typeof order;
  if (order[actC] < order[minC]) {
    return {
      v: 'FAIL',
      why: `confidence too low: expected ≥${minC}, got ${actC}`,
    };
  }

  return { v: 'PASS', why: 'ok' };
}

async function runOne(fx: Fixture): Promise<FixtureResult> {
  currentHistory = fx.customerHistory ?? [];
  const started = Date.now();

  const input: AIResolverInput = {
    tenantId: TENANT_ID,
    city: fx.input.city,
    address1: fx.input.address1,
    address2: fx.input.address2,
    zip: fx.input.zip,
    province: fx.input.province,
    country: fx.input.country,
    customerFirstName: fx.input.customerFirstName,
    customerLastName: fx.input.customerLastName,
    customerEmail: fx.input.customerEmail,
    customerPhone: fx.input.customerPhone,
    orderNotes: fx.input.orderNotes,
  };

  let result: AIResolverResult | null = null;
  let error: string | undefined;
  try {
    result = await resolveAddressWithAI(input);
  } catch (e) {
    error = (e as Error).message;
  }

  const latencyMs = Date.now() - started;

  const webSearches = result?.webSearchRequests ?? 0;

  const actual: FixtureResult['actual'] = result
    ? {
        department: result.department,
        barrio: result.barrio,
        confidence: result.confidence,
        reasoning: result.reasoning,
        deliveryAddress: result.deliveryAddress,
        extraObservations: result.extraObservations,
        rejected: false,
      }
    : {
        department: null,
        barrio: null,
        confidence: null,
        reasoning: null,
        deliveryAddress: null,
        extraObservations: null,
        rejected: true,
      };

  const { v, why } = verdictFor(fx, actual);

  return {
    id: fx.id,
    category: fx.category,
    description: fx.description,
    input: fx.input,
    expected: fx.expected,
    actual,
    verdict: v,
    verdictReason: why,
    latencyMs,
    costUsd: result?.aiCostUsd ?? 0,
    usedHistory: (fx.customerHistory ?? []).length,
    webSearches,
    cacheHit: result?.source === 'cache',
    error,
  };
}

// ─── report generation ──────────────────────────────────────────────────────

function p(n: number, total: number): string {
  if (total === 0) return '—';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[i];
}

function formatReport(results: FixtureResult[]): string {
  const byCategory = new Map<string, FixtureResult[]>();
  for (const r of results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }

  const lines: string[] = [];
  lines.push('# AI Resolver — Audit Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total fixtures: ${results.length}`);
  lines.push('');

  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const fail = results.filter((r) => r.verdict === 'FAIL').length;
  const gap = results.filter((r) => r.verdict === 'GAP').length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const lat = results.map((r) => r.latencyMs);

  lines.push('## Overall');
  lines.push('');
  lines.push(`- **PASS**: ${pass} (${p(pass, results.length)})`);
  lines.push(`- **FAIL**: ${fail} (${p(fail, results.length)})`);
  lines.push(`- **GAP** (documented limitation): ${gap} (${p(gap, results.length)})`);
  lines.push(`- **Total cost**: $${totalCost.toFixed(4)}`);
  lines.push(`- **Latency p50 / p95 / p99**: ${percentile(lat, 50)}ms / ${percentile(lat, 95)}ms / ${percentile(lat, 99)}ms`);
  lines.push('');

  lines.push('## By category');
  lines.push('');
  lines.push('| Cat | Total | Pass | Fail | Gap | Accuracy |');
  lines.push('|---|---|---|---|---|---|');
  const sortedCats = [...byCategory.keys()].sort();
  for (const cat of sortedCats) {
    const rs = byCategory.get(cat)!;
    const cp = rs.filter((r) => r.verdict === 'PASS').length;
    const cf = rs.filter((r) => r.verdict === 'FAIL').length;
    const cg = rs.filter((r) => r.verdict === 'GAP').length;
    lines.push(`| ${cat} | ${rs.length} | ${cp} | ${cf} | ${cg} | ${p(cp, rs.length)} |`);
  }
  lines.push('');

  const failures = results.filter((r) => r.verdict === 'FAIL');
  if (failures.length > 0) {
    lines.push('## Failures (full detail)');
    lines.push('');
    for (const r of failures) {
      lines.push(`### ${r.id} — ${r.description}`);
      lines.push('');
      lines.push(`**Category**: ${r.category}`);
      lines.push(`**Verdict reason**: ${r.verdictReason}`);
      lines.push('');
      lines.push('**Input**:');
      lines.push('```json');
      lines.push(JSON.stringify(r.input, null, 2));
      lines.push('```');
      lines.push('');
      lines.push('**Expected**: ' + JSON.stringify(r.expected));
      lines.push('');
      lines.push('**Actual**:');
      lines.push('```json');
      lines.push(JSON.stringify(r.actual, null, 2));
      lines.push('```');
      if (r.error) lines.push(`**Error**: ${r.error}`);
      lines.push(`**Latency**: ${r.latencyMs}ms — **Cost**: $${r.costUsd.toFixed(6)}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  const gaps = results.filter((r) => r.verdict === 'GAP');
  if (gaps.length > 0) {
    lines.push('## Gaps (expected limitations)');
    lines.push('');
    for (const r of gaps) {
      lines.push(`- **${r.id}** (${r.category}): ${r.description} — ${r.verdictReason}`);
      if (r.actual.reasoning) lines.push(`  - AI reasoning: ${r.actual.reasoning}`);
    }
    lines.push('');
  }

  lines.push('## Recommendation');
  lines.push('');
  const overallAcc = pass / (results.length - gap);
  if (overallAcc >= 0.95) {
    lines.push(`✅ **Ready for production** — accuracy (excluding gaps) = ${(overallAcc * 100).toFixed(1)}%.`);
  } else if (overallAcc >= 0.85) {
    lines.push(`⚠️ **Needs iteration** — accuracy = ${(overallAcc * 100).toFixed(1)}%. Review failures above and tune prompt.`);
  } else {
    lines.push(`❌ **Not ready** — accuracy = ${(overallAcc * 100).toFixed(1)}%. Major prompt work required.`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const fixturesPath = path.join(__dirname, 'resolver-fixtures.json');
  const { fixtures } = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')) as {
    fixtures: Fixture[];
  };

  // Subset filters. `--ids=A01,A03,D07` picks exact fixtures (takes
  // precedence over category/dry-run). `--category=B` filters by category.
  // `--dry-run=N` caps the count (applied AFTER the other two filters).
  const dryRun = argFlag('dry-run');
  const catFilter = argFlag('category');
  const idsFilter = argFlag('ids');
  let selected: Fixture[] = fixtures;
  if (idsFilter) {
    const wanted = new Set(
      idsFilter
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    selected = selected.filter((f) => wanted.has(f.id));
    if (selected.length !== wanted.size) {
      const missing = [...wanted].filter((id) => !selected.some((f) => f.id === id));
      if (missing.length > 0) console.warn(`Unknown fixture IDs skipped: ${missing.join(', ')}`);
    }
  }
  if (catFilter) selected = selected.filter((f) => f.category === catFilter);
  if (dryRun) selected = selected.slice(0, parseInt(dryRun, 10));

  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`Running ${selected.length} fixtures (of ${fixtures.length} total)`);
  if (catFilter) console.log(`  category filter: ${catFilter}`);
  if (dryRun) console.log(`  dry-run limit: ${dryRun}`);
  console.log(`═══════════════════════════════════════════════════════════════\n`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set. Aborting.');
    process.exit(1);
  }

  // Inter-fixture pacing.
  //
  // Anthropic rate limit on our tier is 50k input tokens per minute. Each
  // call runs ~7k input tokens + ~30k cache-creation (on first call every 5
  // min). Average sustained rate stays well under the limit, but bursts
  // (several cache-creation misses back-to-back, or a long web_search plus
  // follow-up) can trip a 429. The resolver itself now retries with
  // exponential backoff; the pacing below is a belt-and-suspenders measure
  // so the suite finishes without retry storms.
  const INTER_FIXTURE_DELAY_MS = 1500;

  const results: FixtureResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    const fx = selected[i];
    const prefix = `[${String(i + 1).padStart(3, '0')}/${String(selected.length).padStart(3, '0')}] ${fx.id} (${fx.category})`;
    process.stdout.write(`${prefix} ${fx.description.padEnd(50, ' ').slice(0, 50)} … `);
    const r = await runOne(fx);
    results.push(r);
    const marker = r.verdict === 'PASS' ? '✓ PASS' : r.verdict === 'GAP' ? '○ GAP' : '✗ FAIL';
    console.log(`${marker}  [${r.latencyMs}ms, $${r.costUsd.toFixed(4)}]${r.verdict !== 'PASS' ? '  ' + r.verdictReason : ''}`);
    if (i < selected.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, INTER_FIXTURE_DELAY_MS));
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');

  // Write raw results
  const resultsOut = path.join(__dirname, 'resolver-suite-results.json');
  fs.writeFileSync(resultsOut, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`Wrote raw results to ${resultsOut}`);

  // Write markdown report
  const reportOut = path.join(__dirname, '..', 'RESOLVER_AUDIT_REPORT.md');
  fs.writeFileSync(reportOut, formatReport(results));
  console.log(`Wrote markdown report to ${reportOut}`);

  // Summary
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const fail = results.filter((r) => r.verdict === 'FAIL').length;
  const gap = results.filter((r) => r.verdict === 'GAP').length;
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  console.log(`\nPass: ${pass}  Fail: ${fail}  Gap: ${gap}  Total cost: $${totalCost.toFixed(4)}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Suite runner crashed:', e);
  process.exit(2);
});
