import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/admin';
import { apiSuccess } from '@/lib/api-utils';
import { fetchAnthropicCostReport, type AnthropicCostSummary } from '@/lib/anthropic-admin';
import { NextResponse } from 'next/server';

/**
 * GET /api/admin/metrics
 *
 * Cross-tenant analytics for the admin dashboard. Wallet-of-truth queries:
 * everything is computed from raw rows (Label, Job, AddressResolution) so a
 * drift in cached counters (Tenant.labelsThisMonth, etc.) doesn't poison
 * the view.
 *
 * Response shape: see AdminMetrics below — the page imports this type.
 */

const DAYS_RANGE = 30;

export interface AdminTenantRow {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  email: string;
  isActive: boolean;
  subscriptionStatus: string;
  plan: string | null; // stripePriceId
  labelsThisMonth: number;       // recomputed from Label rows
  labelsTotal: number;            // tenant cached counter (legacy data)
  labelsLast7Days: number;
  labelsLast30Days: number;
  failedLast30Days: number;
  aiCostUsdLast30Days: number;
  lastRunAt: string | null;
  createdAt: string;
  shopifyConnected: boolean;
  dacConnected: boolean;
  currentPeriodEnd: string | null;
  // Credit-pack billing
  shipmentCredits: number;
  creditsPurchased: number;
  creditsConsumed: number;
  // Referrals
  referralCode: string | null;
  referredById: string | null;
  referralCreditsEarned: number;
}

export interface AdminDailyPoint {
  date: string;          // "YYYY-MM-DD" (UY local)
  labels: number;        // successful labels created that day
  failed: number;        // failed labels that day
  aiCostUsd: number;     // sum of AddressResolution.aiCostUsd that day
  aiCalls: number;       // count of AddressResolution rows that day
}

export interface AdminMetrics {
  generatedAt: string;
  rangeDays: number;

  totals: {
    tenants: number;
    activeTenants: number;
    paidTenants: number;
    labelsToday: number;
    labelsThisMonth: number;
    labelsAllTime: number;
    failedThisMonth: number;
    aiCostUsdThisMonth: number;
    aiCallsThisMonth: number;
    successRate: number; // 0..100
  };

  planDistribution: Array<{ plan: string; count: number }>;

  daily: AdminDailyPoint[]; // length = DAYS_RANGE, oldest first

  topTenants: AdminTenantRow[];     // top 10 by labelsThisMonth
  problemTenants: AdminTenantRow[]; // failed > 0 OR subscription not ACTIVE while using

  // Real Anthropic spend (token + web search + code exec + session). Falls
  // back to { configured: false } if ANTHROPIC_ADMIN_API_KEY is not set.
  // Cached server-side for 5 min (the source updates ~hourly anyway).
  anthropicCost: AnthropicCostSummary;
}

// ── In-memory cache for Anthropic cost report ────────────────────────
// Anthropic's cost report updates roughly hourly. Refreshing every 60s
// (the dashboard's auto-refresh cadence) is wasteful and costs API
// quota. Cache here lives across requests in the same Node process —
// good enough for a single-instance Render service. If we move to
// multi-instance, swap for Redis.
let anthropicCostCache: { at: number; data: AnthropicCostSummary } | null = null;
const ANTHROPIC_CACHE_TTL_MS = 5 * 60 * 1000;

async function getAnthropicCostCached(days: number): Promise<AnthropicCostSummary> {
  const now = Date.now();
  if (anthropicCostCache && now - anthropicCostCache.at < ANTHROPIC_CACHE_TTL_MS) {
    return anthropicCostCache.data;
  }
  const data = await fetchAnthropicCostReport(days);
  // Only cache successful or "not configured" — keep retrying transient errors.
  if (!data.configured || data.fetchedOk) {
    anthropicCostCache = { at: now, data };
  }
  return data;
}

export async function GET() {
  const admin = await getAdminSession();
  if (!admin) {
    // 404 to avoid advertising the endpoint to non-admins.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // ── Time anchors (UY local, since Tenant.timezone defaults to America/Montevideo) ──
  const now = new Date();
  const todayStart = startOfUyDay(now);
  const monthStart = startOfUyMonth(now);
  const rangeStart = new Date(todayStart);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - (DAYS_RANGE - 1));

  // ── All queries in parallel ──
  const [
    tenants,
    labelsToday,
    labelsThisMonth,
    failedThisMonth,
    labelsAllTime,
    aiThisMonth,
    dailyLabels,
    dailyFailed,
    dailyAi,
    perTenantLast7,
    perTenantLast30,
    perTenantFailedLast30,
    perTenantThisMonth,
    perTenantAiLast30,
    anthropicCost,
  ] = await Promise.all([
    db.tenant.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        subscriptionStatus: true,
        stripePriceId: true,
        labelsTotal: true,
        lastRunAt: true,
        createdAt: true,
        currentPeriodEnd: true,
        shopifyStoreUrl: true,
        dacUsername: true,
        // Credit-pack billing
        shipmentCredits: true,
        creditsPurchased: true,
        creditsConsumed: true,
        // Referrals
        referralCode: true,
        referredById: true,
        referralCreditsEarned: true,
        user: { select: { email: true } },
      },
    }),

    db.label.count({
      where: { createdAt: { gte: todayStart }, status: { in: ['CREATED', 'COMPLETED'] } },
    }),
    db.label.count({
      where: { createdAt: { gte: monthStart }, status: { in: ['CREATED', 'COMPLETED'] } },
    }),
    db.label.count({
      where: { createdAt: { gte: monthStart }, status: 'FAILED' },
    }),
    db.label.count({ where: { status: { in: ['CREATED', 'COMPLETED'] } } }),

    db.addressResolution.aggregate({
      where: { createdAt: { gte: monthStart } },
      _sum: { aiCostUsd: true },
      _count: true,
    }),

    // Per-day series — pull raw rows in range and bucket in JS. This is
    // 30 days × N tenants worth of Labels; the query uses the
    // (tenantId, createdAt) index but we don't need GROUP BY here since
    // the result set is bounded by DAYS_RANGE × tenants.
    db.label.findMany({
      where: {
        createdAt: { gte: rangeStart },
        status: { in: ['CREATED', 'COMPLETED'] },
      },
      select: { createdAt: true },
    }),
    db.label.findMany({
      where: { createdAt: { gte: rangeStart }, status: 'FAILED' },
      select: { createdAt: true },
    }),
    db.addressResolution.findMany({
      where: { createdAt: { gte: rangeStart } },
      select: { createdAt: true, aiCostUsd: true },
    }),

    // Per-tenant aggregates. Using groupBy avoids N+1.
    db.label.groupBy({
      by: ['tenantId'],
      where: {
        createdAt: { gte: subtractDays(now, 7) },
        status: { in: ['CREATED', 'COMPLETED'] },
      },
      _count: true,
    }),
    db.label.groupBy({
      by: ['tenantId'],
      where: {
        createdAt: { gte: subtractDays(now, 30) },
        status: { in: ['CREATED', 'COMPLETED'] },
      },
      _count: true,
    }),
    db.label.groupBy({
      by: ['tenantId'],
      where: { createdAt: { gte: subtractDays(now, 30) }, status: 'FAILED' },
      _count: true,
    }),
    db.label.groupBy({
      by: ['tenantId'],
      where: {
        createdAt: { gte: monthStart },
        status: { in: ['CREATED', 'COMPLETED'] },
      },
      _count: true,
    }),
    db.addressResolution.groupBy({
      by: ['tenantId'],
      where: { createdAt: { gte: subtractDays(now, 30) } },
      _sum: { aiCostUsd: true },
    }),

    // Real Anthropic spend — cached for 5 min so 60s dashboard refresh
    // doesn't slam the Admin API.
    getAnthropicCostCached(DAYS_RANGE),
  ]);

  // ── Build per-tenant rows ──
  const last7 = mapByTenant(perTenantLast7, (r) => r._count);
  const last30 = mapByTenant(perTenantLast30, (r) => r._count);
  const failed30 = mapByTenant(perTenantFailedLast30, (r) => r._count);
  const thisMonth = mapByTenant(perTenantThisMonth, (r) => r._count);
  const aiByTenant = mapByTenant(perTenantAiLast30, (r) => r._sum.aiCostUsd ?? 0);

  const rows: AdminTenantRow[] = tenants.map((t) => ({
    tenantId: t.id,
    tenantName: t.name,
    tenantSlug: t.slug,
    email: t.user.email,
    isActive: t.isActive,
    subscriptionStatus: t.subscriptionStatus,
    plan: t.stripePriceId,
    labelsThisMonth: thisMonth.get(t.id) ?? 0,
    labelsTotal: t.labelsTotal,
    labelsLast7Days: last7.get(t.id) ?? 0,
    labelsLast30Days: last30.get(t.id) ?? 0,
    failedLast30Days: failed30.get(t.id) ?? 0,
    aiCostUsdLast30Days: roundUsd(aiByTenant.get(t.id) ?? 0),
    lastRunAt: t.lastRunAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    shopifyConnected: !!t.shopifyStoreUrl,
    dacConnected: !!t.dacUsername,
    currentPeriodEnd: t.currentPeriodEnd?.toISOString() ?? null,
    // Credit-pack billing
    shipmentCredits: t.shipmentCredits,
    creditsPurchased: t.creditsPurchased,
    creditsConsumed: t.creditsConsumed,
    // Referrals
    referralCode: t.referralCode,
    referredById: t.referredById,
    referralCreditsEarned: t.referralCreditsEarned,
  }));

  // ── Daily series (oldest first, contiguous — backfill empty days with 0s) ──
  const dailyMap = new Map<string, AdminDailyPoint>();
  for (let i = 0; i < DAYS_RANGE; i++) {
    const d = new Date(rangeStart);
    d.setUTCDate(d.getUTCDate() + i);
    const key = ymdUy(d);
    dailyMap.set(key, { date: key, labels: 0, failed: 0, aiCostUsd: 0, aiCalls: 0 });
  }
  for (const row of dailyLabels) {
    const k = ymdUy(row.createdAt);
    const p = dailyMap.get(k);
    if (p) p.labels += 1;
  }
  for (const row of dailyFailed) {
    const k = ymdUy(row.createdAt);
    const p = dailyMap.get(k);
    if (p) p.failed += 1;
  }
  for (const row of dailyAi) {
    const k = ymdUy(row.createdAt);
    const p = dailyMap.get(k);
    if (!p) continue;
    p.aiCalls += 1;
    p.aiCostUsd += row.aiCostUsd ?? 0;
  }
  const daily = Array.from(dailyMap.values()).map((p) => ({
    ...p,
    aiCostUsd: roundUsd(p.aiCostUsd),
  }));

  // ── Plan distribution ──
  const planCounts = new Map<string, number>();
  for (const t of tenants) {
    const key = t.subscriptionStatus === 'ACTIVE' && t.stripePriceId ? t.stripePriceId : 'inactive';
    planCounts.set(key, (planCounts.get(key) ?? 0) + 1);
  }
  const planDistribution = Array.from(planCounts.entries())
    .map(([plan, count]) => ({ plan, count }))
    .sort((a, b) => b.count - a.count);

  // ── Top + problem tenants ──
  const topTenants = [...rows]
    .sort((a, b) => b.labelsThisMonth - a.labelsThisMonth)
    .slice(0, 10);

  const problemTenants = rows.filter((r) => {
    if (r.failedLast30Days > 0) return true;
    // Active usage but subscription is not in good standing.
    if (r.labelsThisMonth > 0 && r.subscriptionStatus !== 'ACTIVE' && r.subscriptionStatus !== 'TRIALING') {
      return true;
    }
    return false;
  })
  .sort((a, b) => b.failedLast30Days - a.failedLast30Days)
  .slice(0, 20);

  // ── Totals ──
  const aiCostUsdThisMonth = roundUsd(aiThisMonth._sum.aiCostUsd ?? 0);
  const successRate =
    labelsThisMonth + failedThisMonth > 0
      ? Math.round((labelsThisMonth / (labelsThisMonth + failedThisMonth)) * 1000) / 10
      : 100;

  const result: AdminMetrics = {
    generatedAt: new Date().toISOString(),
    rangeDays: DAYS_RANGE,
    totals: {
      tenants: tenants.length,
      activeTenants: tenants.filter((t) => t.isActive).length,
      paidTenants: tenants.filter(
        (t) => t.subscriptionStatus === 'ACTIVE' || t.subscriptionStatus === 'TRIALING',
      ).length,
      labelsToday,
      labelsThisMonth,
      labelsAllTime,
      failedThisMonth,
      aiCostUsdThisMonth,
      aiCallsThisMonth: aiThisMonth._count,
      successRate,
    },
    planDistribution,
    daily,
    topTenants,
    problemTenants,
    anthropicCost,
  };

  return apiSuccess(result);
}

// ─── helpers ───────────────────────────────────────────────────────────

function mapByTenant<T extends { tenantId: string }, V>(
  rows: T[],
  pick: (r: T) => V,
): Map<string, V> {
  const m = new Map<string, V>();
  for (const r of rows) m.set(r.tenantId, pick(r));
  return m;
}

function subtractDays(now: Date, days: number): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function roundUsd(n: number): number {
  return Math.round(n * 10000) / 10000; // 4 decimals — AI calls are tiny per-call.
}

/**
 * Returns the start of "today" anchored to America/Montevideo.
 *
 * UY is UTC-3 with no DST since 2015, so this hardcoded offset is safe
 * for the foreseeable future. If UY ever reintroduces DST we'd switch to
 * Intl.DateTimeFormat zoning — but for now the simple offset avoids a
 * dependency on Node's tz database being present in the deploy image.
 */
function startOfUyDay(d: Date): Date {
  // Convert to UY: subtract 3 hours, take date components, then add back.
  const uy = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const y = uy.getUTCFullYear();
  const m = uy.getUTCMonth();
  const day = uy.getUTCDate();
  // Midnight UY in UTC = midnight local + 3h
  return new Date(Date.UTC(y, m, day, 3, 0, 0, 0));
}

function startOfUyMonth(d: Date): Date {
  const uy = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const y = uy.getUTCFullYear();
  const m = uy.getUTCMonth();
  return new Date(Date.UTC(y, m, 1, 3, 0, 0, 0));
}

function ymdUy(d: Date): string {
  const uy = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const y = uy.getUTCFullYear();
  const m = String(uy.getUTCMonth() + 1).padStart(2, '0');
  const day = String(uy.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
