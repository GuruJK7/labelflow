import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/admin';
import { apiSuccess } from '@/lib/api-utils';
import { fetchAnthropicCostReport, type AnthropicCostSummary } from '@/lib/anthropic-admin';
import { NextResponse, type NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';

/**
 * GET /api/admin/metrics?tenantId=<id>&range=<7|30|90>
 *
 * Cross-tenant analytics for the admin dashboard. Wallet-of-truth queries:
 * everything is computed from raw rows (Label, Job, AddressResolution,
 * CreditPurchase, ReferralCreditAccrual) so a drift in cached counters
 * (Tenant.labelsThisMonth, Tenant.creditsPurchased, etc.) doesn't poison
 * the view.
 *
 * Filters (both optional, default = global / 30 days):
 *   - tenantId: restrict the *aggregate* metrics to one store. Cross-tenant
 *     tables (top tenants, top payers, per-store comparisons) stay global —
 *     the page hides them when a store is selected.
 *   - range:    time window for the daily series + breakdowns + trends.
 *
 * Back-compat: with no params (tenantId absent, range=30) the response is
 * byte-identical to the previous version. The store filter is implemented
 * by spreading `scope` (an empty object when global) into every where —
 * `{ ...where, ...{} }` === `{ ...where }` — so the "Todas" view can't drift.
 *
 * Response shape: see AdminMetrics below — the page imports this type.
 */

const DEFAULT_RANGE_DAYS = 30;
const ALLOWED_RANGES = [7, 30, 90];
const HOURLY_RANGE_DAYS = 7;

// Order-value histogram buckets (UYU). Calibrated to the real distribution
// (median ~1.5k, p90 ~3.4k, max ~8k) so the chart shows useful spread instead
// of a single dominant bar.
const VALUE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '< $1k', min: 0, max: 1000 },
  { label: '$1k–1,5k', min: 1000, max: 1500 },
  { label: '$1,5k–2k', min: 1500, max: 2000 },
  { label: '$2k–3k', min: 2000, max: 3000 },
  { label: '$3k–5k', min: 3000, max: 5000 },
  { label: '$5k+', min: 5000, max: Infinity },
];

// ─── Existing types (kept stable so older clients keep working) ──────

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

// ─── New types (admin v2: errors, payments, referrals, hourly) ───────

export interface AdminStatusBucket {
  status: string;        // LabelStatus value as string ('CREATED' | 'COMPLETED' | ...)
  count: number;
}

export interface AdminErrorBucket {
  signature: string;     // normalized prefix used for grouping (lowercase, ≤ 80 chars)
  count: number;
  lastSeen: string;      // ISO of the most recent occurrence
  example: string;       // raw example (truncated at 200 chars) for tooltips
}

export interface AdminPaymentFailureBucket {
  reason: string;        // 'card_rejected' | '3ds_required' | 'timeout' | 'saved_card_not_found' | 'selector_failure' | 'other'
  count: number;
}

export interface AdminAiModelBucket {
  model: string;         // 'claude-haiku-4-5-20251001' | 'unknown'
  calls: number;
  costUsd: number;       // sum of aiCostUsd
  acceptedRate: number;  // 0..100, share of dacAccepted = true (null/false count as not accepted)
}

export interface AdminJobBucket {
  status: string;        // JobStatus value as string
  count: number;
  avgDurationSec: number | null; // null when no rows had a recorded durationMs
}

export interface AdminRevenueDailyPoint {
  date: string;          // "YYYY-MM-DD" (UY local)
  uyu: number;           // sum of CreditPurchase.totalPriceUyu (status=PAID, by paidAt)
  shipments: number;     // sum of shipments sold that day
  count: number;         // number of PAID purchases that day
}

export interface AdminPaymentRow {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  packId: string;
  shipments: number;
  totalPriceUyu: number;
  status: string;        // CreditPurchaseStatus
  paidAt: string | null; // ISO
  createdAt: string;     // ISO
}

export interface AdminTopPayerRow {
  tenantId: string;
  tenantName: string;
  email: string;
  totalUyu: number;
  totalShipments: number;
  purchaseCount: number;
  lastPaidAt: string | null;
}

export interface AdminTopReferrerRow {
  tenantId: string;
  tenantName: string;
  email: string;
  referralCode: string | null;
  refereesCount: number;        // direct referees (Tenant.referredById = this)
  shipmentsAccrued: number;     // sum of bonus credits earned from referees buying packs
  accrualCount: number;
}

export interface AdminHourlyPoint {
  hour: number;          // 0..23 (UY local)
  labels: number;        // successful labels in this hour, summed across the last HOURLY_RANGE_DAYS
  failed: number;
}

// ─── New types (admin v3: store filter, range, geo, payment mix, value, trends) ──

export interface AdminGeoBucket {
  name: string;          // department or city (raw value, '(sin dato)' if empty)
  count: number;
}

export interface AdminPaymentTypeBucket {
  type: string;          // 'REMITENTE' (store pays shipping) | 'DESTINATARIO' (customer pays COD)
  count: number;
}

export interface AdminPaymentStatusBucket {
  status: string;        // 'not_required' | 'paid' | 'pending_manual' | 'failed_rejected'
  count: number;
}

export interface AdminJobTypeBucket {
  type: string;          // JobType: 'PROCESS_ORDERS' | 'PROCESS_ORDERS_BULK' | 'RETRY_FAILED' | 'TEST_DAC'
  count: number;
}

export interface AdminValueBucket {
  label: string;
  count: number;
}

export interface AdminValueStats {
  count: number;         // number of successful labels with a positive order value in range
  avgUyu: number;
  medianUyu: number;
  minUyu: number;
  maxUyu: number;
  buckets: AdminValueBucket[];
}

export interface AdminTrendMetric {
  current: number;       // value in the current range window
  previous: number;      // value in the immediately preceding window of equal length
  deltaPct: number | null; // relative % change vs previous; null when previous == 0
}

export interface AdminTrends {
  labels: AdminTrendMetric;
  failed: AdminTrendMetric;
  successRate: AdminTrendMetric; // values are 0..100 percentages
  revenueUyu: AdminTrendMetric;
  aiCostUsd: AdminTrendMetric;
}

export interface AdminLabelsByTenantRow {
  tenantId: string;
  tenantName: string;
  count: number;
}

export interface AdminRevenueByTenantRow {
  tenantId: string;
  tenantName: string;
  uyu: number;
  count: number;
}

export interface AdminMetrics {
  generatedAt: string;
  rangeDays: number;
  hourlyRangeDays: number;

  // Active store filter (null = all stores aggregated).
  scopedTenantId: string | null;
  scopedTenantName: string | null;

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

    // Revenue (UYU). Uses CreditPurchase.status=PAID.
    revenueUyuThisMonth: number;
    revenueUyuLast30Days: number;   // current range window (name kept for back-compat)
    revenueUyuAllTime: number;
    paidPurchasesLast30Days: number; // current range window
    aovUyuLast30Days: number;        // average order value in UYU, current range window

    // Referrals
    referralAccrualsAllTime: number;
    referralShipmentsAccruedAllTime: number;
    refereesActiveCount: number; // tenants with referredById != null
  };

  // Labels created in the current range window (used by the range KPI cards).
  rangeLabelsTotal: number;
  rangeFailedTotal: number;

  trends: AdminTrends;

  planDistribution: Array<{ plan: string; count: number }>;

  daily: AdminDailyPoint[]; // length = rangeDays, oldest first
  revenueDaily: AdminRevenueDailyPoint[]; // length = rangeDays, oldest first
  hourlyLast7d: AdminHourlyPoint[];       // length = 24, hour 0..23 UY local

  topTenants: AdminTenantRow[];     // top 10 by labelsThisMonth (always global)
  problemTenants: AdminTenantRow[]; // failed > 0 OR subscription not ACTIVE while using (always global)

  // Drill-downs (scoped to the selected store; follow the range window)
  statusBreakdown30d: AdminStatusBucket[];
  errorBreakdown30d: AdminErrorBucket[];           // top 10 normalized error messages
  paymentFailureBreakdown30d: AdminPaymentFailureBucket[];
  aiModelBreakdown30d: AdminAiModelBucket[];
  jobsBreakdown30d: AdminJobBucket[];

  // Geography / payment mix / value (scoped, range window)
  geographyTop: AdminGeoBucket[];     // by department, sorted desc
  cityTop: AdminGeoBucket[];          // top cities
  paymentTypeBreakdown: AdminPaymentTypeBucket[];
  paymentStatusBreakdown: AdminPaymentStatusBucket[];
  jobTypeBreakdown: AdminJobTypeBucket[];
  valueStats: AdminValueStats;

  // Cross-store comparisons (always global; the page hides them when scoped)
  labelsByTenant: AdminLabelsByTenantRow[];
  revenueByTenant: AdminRevenueByTenantRow[];

  // Payments / Referrals (always global)
  recentPayments: AdminPaymentRow[];     // last 20 (any status)
  topPayers: AdminTopPayerRow[];         // top 10 by lifetime UYU paid
  topReferrers: AdminTopReferrerRow[];   // top 10 by lifetime shipmentsAccrued

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
// multi-instance, swap for Redis. Keyed on `days` so switching range
// presets doesn't serve a stale window.
let anthropicCostCache: { at: number; days: number; data: AnthropicCostSummary } | null = null;
const ANTHROPIC_CACHE_TTL_MS = 5 * 60 * 1000;

async function getAnthropicCostCached(days: number): Promise<AnthropicCostSummary> {
  const now = Date.now();
  if (
    anthropicCostCache &&
    anthropicCostCache.days === days &&
    now - anthropicCostCache.at < ANTHROPIC_CACHE_TTL_MS
  ) {
    return anthropicCostCache.data;
  }
  const data = await fetchAnthropicCostReport(days);
  // Only cache successful or "not configured" — keep retrying transient errors.
  if (!data.configured || data.fetchedOk) {
    anthropicCostCache = { at: now, days, data };
  }
  return data;
}

export async function GET(req: NextRequest) {
  const admin = await getAdminSession();
  if (!admin) {
    // 404 to avoid advertising the endpoint to non-admins.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // ── Parse filters ──
  const rangeParam = parseInt(req.nextUrl.searchParams.get('range') ?? '', 10);
  const rangeDays = ALLOWED_RANGES.includes(rangeParam) ? rangeParam : DEFAULT_RANGE_DAYS;
  const rawTenantId = req.nextUrl.searchParams.get('tenantId');

  // Validate the requested store BEFORE the big query. If it doesn't exist
  // we silently fall back to the global view (the dropdown is fed from our
  // own data, so a bad id means a stale client — degrade, don't 500).
  let scopeTenantId: string | null = null;
  let scopedTenantName: string | null = null;
  if (rawTenantId) {
    const t = await db.tenant.findUnique({
      where: { id: rawTenantId },
      select: { id: true, name: true, slug: true },
    });
    if (t) {
      scopeTenantId = t.id;
      scopedTenantName = t.name || t.slug;
    }
  }
  // Spread-able scope: `{}` when global so `{ ...where, ...scope }` is a no-op.
  const scope: Prisma.LabelWhereInput = scopeTenantId ? { tenantId: scopeTenantId } : {};
  const jobScope: Prisma.JobWhereInput = scopeTenantId ? { tenantId: scopeTenantId } : {};
  const arScope: Prisma.AddressResolutionWhereInput = scopeTenantId ? { tenantId: scopeTenantId } : {};
  const cpScope: Prisma.CreditPurchaseWhereInput = scopeTenantId ? { tenantId: scopeTenantId } : {};

  // ── Time anchors (UY local, since Tenant.timezone defaults to America/Montevideo) ──
  const now = new Date();
  const todayStart = startOfUyDay(now);
  const monthStart = startOfUyMonth(now);
  const rangeStart = new Date(todayStart);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - (rangeDays - 1));
  // Immediately preceding window of equal length, for trend deltas.
  const prevRangeStart = new Date(rangeStart);
  prevRangeStart.setUTCDate(prevRangeStart.getUTCDate() - rangeDays);
  const hourlyRangeStart = new Date(todayStart);
  hourlyRangeStart.setUTCDate(hourlyRangeStart.getUTCDate() - (HOURLY_RANGE_DAYS - 1));

  // ── All queries in parallel ──
  // Keep this list disciplined: every query here adds latency to the
  // dashboard cold render. We try to do GROUP BY in SQL where possible
  // (cheaper than pulling raw rows + bucketing in Node) and only fall
  // back to findMany when we need a non-aggregate field (e.g. errorMessage).
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
    statusBreakdownRaw,
    failedLabelDetails30d,
    aiModelGroup30d,
    jobsGroup30d,
    paidPurchasesRange,
    paidPurchasesAllTime,
    paidPurchasesByTenantAll,
    recentPurchasesRaw,
    referralAccrualsByReferrer,
    referralAccrualsTotalsAll,
    refereesCount,
    revenueThisMonth,
    // ── new (admin v3) ──
    prevLabelsOk,
    prevFailed,
    prevAi,
    prevRevenue,
    deptGroup,
    cityGroup,
    paymentTypeGroup,
    paymentStatusGroup,
    jobTypeGroup,
    labelsByTenantRange,
    revenueByTenantRange,
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
      where: { ...scope, createdAt: { gte: todayStart }, status: { in: ['CREATED', 'COMPLETED'] } },
    }),
    db.label.count({
      where: { ...scope, createdAt: { gte: monthStart }, status: { in: ['CREATED', 'COMPLETED'] } },
    }),
    db.label.count({
      where: { ...scope, createdAt: { gte: monthStart }, status: 'FAILED' },
    }),
    db.label.count({ where: { ...scope, status: { in: ['CREATED', 'COMPLETED'] } } }),

    db.addressResolution.aggregate({
      where: { ...arScope, createdAt: { gte: monthStart } },
      _sum: { aiCostUsd: true },
      _count: true,
    }),

    // Per-day series — pull raw rows in range and bucket in JS. This is
    // rangeDays × N tenants worth of Labels; the query uses the
    // (tenantId, createdAt) index but we don't need GROUP BY here since
    // the result set is bounded. We also pull totalUyu so the order-value
    // distribution reuses the same rows (no extra round-trip).
    db.label.findMany({
      where: {
        ...scope,
        createdAt: { gte: rangeStart },
        status: { in: ['CREATED', 'COMPLETED'] },
      },
      select: { createdAt: true, totalUyu: true },
    }),
    db.label.findMany({
      where: { ...scope, createdAt: { gte: rangeStart }, status: 'FAILED' },
      select: { createdAt: true },
    }),
    db.addressResolution.findMany({
      where: { ...arScope, createdAt: { gte: rangeStart } },
      select: { createdAt: true, aiCostUsd: true },
    }),

    // Per-tenant aggregates (always global — they feed the cross-tenant
    // tables, which the page hides when a store is selected). Using groupBy
    // avoids N+1. Fixed 7d / 30d windows: these power the table columns
    // literally labelled "7d" / "30d", independent of the range selector.
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

    // ── Status breakdown (range, all statuses) ──
    db.label.groupBy({
      by: ['status'],
      where: { ...scope, createdAt: { gte: rangeStart } },
      _count: true,
    }),

    // ── Failed labels — pulled with errorMessage so we can normalize+bucket
    //    in JS. Bounded by failed-count, which on a healthy system is small.
    db.label.findMany({
      where: {
        ...scope,
        createdAt: { gte: rangeStart },
        status: 'FAILED',
      },
      select: {
        errorMessage: true,
        paymentFailureReason: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),

    // ── AI model breakdown ──
    db.addressResolution.groupBy({
      by: ['aiModel', 'dacAccepted'],
      where: { ...arScope, createdAt: { gte: rangeStart } },
      _count: true,
      _sum: { aiCostUsd: true },
    }),

    // ── Jobs by status (range) ──
    db.job.groupBy({
      by: ['status'],
      where: { ...jobScope, createdAt: { gte: rangeStart } },
      _count: true,
      _avg: { durationMs: true },
    }),

    // ── Credit purchases — daily revenue (range, only PAID) ──
    db.creditPurchase.findMany({
      where: {
        ...cpScope,
        status: 'PAID',
        paidAt: { gte: rangeStart, not: null },
      },
      select: {
        paidAt: true,
        totalPriceUyu: true,
        shipments: true,
      },
    }),

    // ── Lifetime revenue total (PAID only) ──
    db.creditPurchase.aggregate({
      where: { ...cpScope, status: 'PAID' },
      _sum: { totalPriceUyu: true, shipments: true },
      _count: true,
    }),

    // ── Per-tenant lifetime PAID totals (global — feeds top payers) ──
    db.creditPurchase.groupBy({
      by: ['tenantId'],
      where: { status: 'PAID' },
      _sum: { totalPriceUyu: true, shipments: true },
      _count: true,
      _max: { paidAt: true },
    }),

    // ── Recent purchases (any status) for the audit table (global) ──
    db.creditPurchase.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        tenantId: true,
        packId: true,
        shipments: true,
        totalPriceUyu: true,
        status: true,
        paidAt: true,
        createdAt: true,
        tenant: {
          select: {
            name: true,
            user: { select: { email: true } },
          },
        },
      },
    }),

    // ── Referral accruals grouped by referrer (lifetime, global) ──
    db.referralCreditAccrual.groupBy({
      by: ['referrerTenantId'],
      _sum: { shipmentsAccrued: true },
      _count: true,
    }),

    // ── Lifetime referral totals (global) ──
    db.referralCreditAccrual.aggregate({
      _sum: { shipmentsAccrued: true },
      _count: true,
    }),

    // ── How many tenants are referees (have referredById set) (global) ──
    db.tenant.count({ where: { referredById: { not: null } } }),

    // ── Revenue this UY-month (PAID only, by paidAt) ──
    db.creditPurchase.aggregate({
      where: {
        ...cpScope,
        status: 'PAID',
        paidAt: { gte: monthStart, not: null },
      },
      _sum: { totalPriceUyu: true },
    }),

    // ─────────── new (admin v3) — all scoped + range-windowed ───────────

    // Previous-window counts for trend deltas.
    db.label.count({
      where: {
        ...scope,
        createdAt: { gte: prevRangeStart, lt: rangeStart },
        status: { in: ['CREATED', 'COMPLETED'] },
      },
    }),
    db.label.count({
      where: { ...scope, createdAt: { gte: prevRangeStart, lt: rangeStart }, status: 'FAILED' },
    }),
    db.addressResolution.aggregate({
      where: { ...arScope, createdAt: { gte: prevRangeStart, lt: rangeStart } },
      _sum: { aiCostUsd: true },
    }),
    db.creditPurchase.aggregate({
      where: { ...cpScope, status: 'PAID', paidAt: { gte: prevRangeStart, lt: rangeStart } },
      _sum: { totalPriceUyu: true },
    }),

    // Geography — where successful shipments are going (range).
    db.label.groupBy({
      by: ['department'],
      where: { ...scope, createdAt: { gte: rangeStart }, status: { in: ['CREATED', 'COMPLETED'] } },
      _count: true,
    }),
    db.label.groupBy({
      by: ['city'],
      where: { ...scope, createdAt: { gte: rangeStart }, status: { in: ['CREATED', 'COMPLETED'] } },
      _count: true,
    }),

    // Payment mix — who pays shipping (REMITENTE = store, DESTINATARIO = customer COD).
    db.label.groupBy({
      by: ['paymentType'],
      where: { ...scope, createdAt: { gte: rangeStart }, status: { in: ['CREATED', 'COMPLETED'] } },
      _count: true,
    }),
    // Auto-pay collection health (range).
    db.label.groupBy({
      by: ['paymentStatus'],
      where: { ...scope, createdAt: { gte: rangeStart } },
      _count: true,
    }),

    // Worker jobs by type (range).
    db.job.groupBy({
      by: ['type'],
      where: { ...jobScope, createdAt: { gte: rangeStart } },
      _count: true,
    }),

    // Cross-store comparisons (global — hidden when scoped).
    db.label.groupBy({
      by: ['tenantId'],
      where: { createdAt: { gte: rangeStart }, status: { in: ['CREATED', 'COMPLETED'] } },
      _count: true,
    }),
    db.creditPurchase.groupBy({
      by: ['tenantId'],
      where: { status: 'PAID', paidAt: { gte: rangeStart, not: null } },
      _sum: { totalPriceUyu: true },
      _count: true,
    }),

    // Real Anthropic spend — cached for 5 min so 60s dashboard refresh
    // doesn't slam the Admin API. Global (not per-tenant); the page uses the
    // scoped per-tenant Address Resolver line instead when a store is selected.
    getAnthropicCostCached(rangeDays),
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

  // Lookup table for joining tenantId → name/email in the Payment / Referrer tables.
  const tenantLookup = new Map<string, { name: string; email: string }>();
  for (const t of tenants) {
    tenantLookup.set(t.id, { name: t.name, email: t.user.email });
  }

  // ── Daily series (oldest first, contiguous — backfill empty days with 0s) ──
  const dailyMap = new Map<string, AdminDailyPoint>();
  const revenueDailyMap = new Map<string, AdminRevenueDailyPoint>();
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(rangeStart);
    d.setUTCDate(d.getUTCDate() + i);
    const key = ymdUy(d);
    dailyMap.set(key, { date: key, labels: 0, failed: 0, aiCostUsd: 0, aiCalls: 0 });
    revenueDailyMap.set(key, { date: key, uyu: 0, shipments: 0, count: 0 });
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
  for (const row of paidPurchasesRange) {
    if (!row.paidAt) continue;
    const k = ymdUy(row.paidAt);
    const p = revenueDailyMap.get(k);
    if (!p) continue;
    p.uyu += row.totalPriceUyu;
    p.shipments += row.shipments;
    p.count += 1;
  }
  const daily = Array.from(dailyMap.values()).map((p) => ({
    ...p,
    aiCostUsd: roundUsd(p.aiCostUsd),
  }));
  const revenueDaily = Array.from(revenueDailyMap.values()).map((p) => ({
    ...p,
    uyu: roundUyu(p.uyu),
  }));

  // ── Hourly distribution (last 7 days, 24 buckets, UY local hour) ──
  const hourlyBuckets: AdminHourlyPoint[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    labels: 0,
    failed: 0,
  }));
  for (const row of dailyLabels) {
    if (row.createdAt < hourlyRangeStart) continue;
    const h = hourUy(row.createdAt);
    hourlyBuckets[h].labels += 1;
  }
  for (const row of dailyFailed) {
    if (row.createdAt < hourlyRangeStart) continue;
    const h = hourUy(row.createdAt);
    hourlyBuckets[h].failed += 1;
  }

  // ── Order-value distribution (reuses dailyLabels rows; range, scoped) ──
  const values = dailyLabels
    .map((r) => r.totalUyu)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const valueCount = values.length;
  const valueSum = values.reduce((s, v) => s + v, 0);
  const valueAvg = valueCount > 0 ? valueSum / valueCount : 0;
  const valueMedian =
    valueCount === 0
      ? 0
      : valueCount % 2 === 1
        ? values[(valueCount - 1) / 2]
        : (values[valueCount / 2 - 1] + values[valueCount / 2]) / 2;
  const valueStats: AdminValueStats = {
    count: valueCount,
    avgUyu: roundUyu(valueAvg),
    medianUyu: roundUyu(valueMedian),
    minUyu: valueCount > 0 ? roundUyu(values[0]) : 0,
    maxUyu: valueCount > 0 ? roundUyu(values[valueCount - 1]) : 0,
    buckets: VALUE_BUCKETS.map((b) => ({
      label: b.label,
      count: values.filter((v) => v >= b.min && v < b.max).length,
    })),
  };

  // ── Status breakdown (range) ──
  const statusBreakdown30d: AdminStatusBucket[] = statusBreakdownRaw
    .map((r) => ({ status: r.status, count: r._count }))
    .sort((a, b) => b.count - a.count);

  // ── Geography (range, scoped) ──
  const geographyTop: AdminGeoBucket[] = deptGroup
    .map((g) => ({ name: g.department || '(sin dato)', count: g._count }))
    .sort((a, b) => b.count - a.count);
  const cityTop: AdminGeoBucket[] = cityGroup
    .map((g) => ({ name: g.city || '(sin dato)', count: g._count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  // ── Payment mix (range, scoped) ──
  const paymentTypeBreakdown: AdminPaymentTypeBucket[] = paymentTypeGroup
    .map((g) => ({ type: g.paymentType as string, count: g._count }))
    .sort((a, b) => b.count - a.count);
  const paymentStatusBreakdown: AdminPaymentStatusBucket[] = paymentStatusGroup
    .map((g) => ({ status: g.paymentStatus ?? 'not_required', count: g._count }))
    .sort((a, b) => b.count - a.count);

  // ── Worker job types (range, scoped) ──
  const jobTypeBreakdown: AdminJobTypeBucket[] = jobTypeGroup
    .map((g) => ({ type: g.type as string, count: g._count }))
    .sort((a, b) => b.count - a.count);

  // ── Cross-store comparisons (global) ──
  const labelsByTenant: AdminLabelsByTenantRow[] = labelsByTenantRange
    .map((g) => ({
      tenantId: g.tenantId,
      tenantName: tenantLookup.get(g.tenantId)?.name ?? '—',
      count: g._count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  const revenueByTenant: AdminRevenueByTenantRow[] = revenueByTenantRange
    .map((g) => ({
      tenantId: g.tenantId,
      tenantName: tenantLookup.get(g.tenantId)?.name ?? '—',
      uyu: roundUyu(g._sum.totalPriceUyu ?? 0),
      count: g._count,
    }))
    .filter((r) => r.uyu > 0)
    .sort((a, b) => b.uyu - a.uyu)
    .slice(0, 12);

  // ── Error breakdown — normalize errorMessage and bucket ──
  // We don't want every "Pedido 1234 ya tiene guía" to be its own bucket;
  // we strip numeric IDs / UUIDs / quoted bits so the same template
  // lands in the same bucket regardless of which order triggered it.
  const errorBucketMap = new Map<
    string,
    { count: number; lastSeen: Date; example: string }
  >();
  const paymentFailureMap = new Map<string, number>();
  for (const row of failedLabelDetails30d) {
    if (row.paymentFailureReason) {
      const reason = row.paymentFailureReason;
      paymentFailureMap.set(reason, (paymentFailureMap.get(reason) ?? 0) + 1);
    }
    if (row.errorMessage) {
      const sig = normalizeErrorMessage(row.errorMessage);
      const existing = errorBucketMap.get(sig);
      if (existing) {
        existing.count += 1;
        if (row.createdAt > existing.lastSeen) existing.lastSeen = row.createdAt;
      } else {
        errorBucketMap.set(sig, {
          count: 1,
          lastSeen: row.createdAt,
          example: row.errorMessage.slice(0, 200),
        });
      }
    }
  }
  const errorBreakdown30d: AdminErrorBucket[] = Array.from(errorBucketMap.entries())
    .map(([signature, v]) => ({
      signature,
      count: v.count,
      lastSeen: v.lastSeen.toISOString(),
      example: v.example,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const paymentFailureBreakdown30d: AdminPaymentFailureBucket[] = Array.from(
    paymentFailureMap.entries(),
  )
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // ── AI model breakdown ──
  // The groupBy is by (aiModel, dacAccepted) so we can compute the
  // "DAC accepted" rate per model without a second round-trip.
  const aiModelAggMap = new Map<
    string,
    { calls: number; costUsd: number; accepted: number }
  >();
  for (const row of aiModelGroup30d) {
    const model = row.aiModel ?? 'unknown';
    const bucket = aiModelAggMap.get(model) ?? { calls: 0, costUsd: 0, accepted: 0 };
    bucket.calls += row._count;
    bucket.costUsd += row._sum.aiCostUsd ?? 0;
    if (row.dacAccepted === true) bucket.accepted += row._count;
    aiModelAggMap.set(model, bucket);
  }
  const aiModelBreakdown30d: AdminAiModelBucket[] = Array.from(aiModelAggMap.entries())
    .map(([model, v]) => ({
      model,
      calls: v.calls,
      costUsd: roundUsd(v.costUsd),
      acceptedRate: v.calls > 0 ? Math.round((v.accepted / v.calls) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // ── Jobs breakdown ──
  const jobsBreakdown30d: AdminJobBucket[] = jobsGroup30d
    .map((row) => ({
      status: row.status,
      count: row._count,
      avgDurationSec:
        row._avg.durationMs != null ? Math.round(row._avg.durationMs / 100) / 10 : null,
    }))
    .sort((a, b) => b.count - a.count);

  // ── Plan distribution (global) ──
  const planCounts = new Map<string, number>();
  for (const t of tenants) {
    const key = t.subscriptionStatus === 'ACTIVE' && t.stripePriceId ? t.stripePriceId : 'inactive';
    planCounts.set(key, (planCounts.get(key) ?? 0) + 1);
  }
  const planDistribution = Array.from(planCounts.entries())
    .map(([plan, count]) => ({ plan, count }))
    .sort((a, b) => b.count - a.count);

  // ── Top + problem tenants (global) ──
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

  // ── Recent payments (global) ──
  const recentPayments: AdminPaymentRow[] = recentPurchasesRaw.map((p) => ({
    id: p.id,
    tenantId: p.tenantId,
    tenantName: p.tenant?.name ?? 'desconocido',
    email: p.tenant?.user?.email ?? '',
    packId: p.packId,
    shipments: p.shipments,
    totalPriceUyu: p.totalPriceUyu,
    status: p.status,
    paidAt: p.paidAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  }));

  // ── Top payers (lifetime PAID totals, global) ──
  const topPayers: AdminTopPayerRow[] = paidPurchasesByTenantAll
    .map((g) => {
      const t = tenantLookup.get(g.tenantId);
      return {
        tenantId: g.tenantId,
        tenantName: t?.name ?? '—',
        email: t?.email ?? '',
        totalUyu: roundUyu(g._sum.totalPriceUyu ?? 0),
        totalShipments: g._sum.shipments ?? 0,
        purchaseCount: g._count,
        lastPaidAt: g._max.paidAt?.toISOString() ?? null,
      };
    })
    .sort((a, b) => b.totalUyu - a.totalUyu)
    .slice(0, 10);

  // ── Top referrers (lifetime accruals, global) ──
  // refereesCount comes from counting tenants where referredById = this.id.
  const refereesPerReferrer = new Map<string, number>();
  for (const t of tenants) {
    if (t.referredById) {
      refereesPerReferrer.set(
        t.referredById,
        (refereesPerReferrer.get(t.referredById) ?? 0) + 1,
      );
    }
  }
  const topReferrers: AdminTopReferrerRow[] = referralAccrualsByReferrer
    .map((g) => {
      const t = tenantLookup.get(g.referrerTenantId);
      const tenantRow = tenants.find((tt) => tt.id === g.referrerTenantId);
      return {
        tenantId: g.referrerTenantId,
        tenantName: t?.name ?? '—',
        email: t?.email ?? '',
        referralCode: tenantRow?.referralCode ?? null,
        refereesCount: refereesPerReferrer.get(g.referrerTenantId) ?? 0,
        shipmentsAccrued: g._sum.shipmentsAccrued ?? 0,
        accrualCount: g._count,
      };
    })
    .filter((r) => r.shipmentsAccrued > 0 || r.refereesCount > 0)
    .sort((a, b) => b.shipmentsAccrued - a.shipmentsAccrued)
    .slice(0, 10);

  // ── Totals (scoped where the store filter applies) ──
  const aiCostUsdThisMonth = roundUsd(aiThisMonth._sum.aiCostUsd ?? 0);
  const successRate =
    labelsThisMonth + failedThisMonth > 0
      ? Math.round((labelsThisMonth / (labelsThisMonth + failedThisMonth)) * 1000) / 10
      : 100;

  const revenueRange = paidPurchasesRange.reduce((s, p) => s + p.totalPriceUyu, 0);
  const aovUyuRange =
    paidPurchasesRange.length > 0 ? revenueRange / paidPurchasesRange.length : 0;

  // ── Trends: current range window vs the immediately preceding window ──
  const rangeLabelsTotal = dailyLabels.length;
  const rangeFailedTotal = dailyFailed.length;
  const rangeAiCostUsd = dailyAi.reduce((s, r) => s + (r.aiCostUsd ?? 0), 0);
  const curSuccessRate =
    rangeLabelsTotal + rangeFailedTotal > 0
      ? Math.round((rangeLabelsTotal / (rangeLabelsTotal + rangeFailedTotal)) * 1000) / 10
      : 100;
  const prevLabelsOkN = prevLabelsOk;
  const prevFailedN = prevFailed;
  const prevSuccessRate =
    prevLabelsOkN + prevFailedN > 0
      ? Math.round((prevLabelsOkN / (prevLabelsOkN + prevFailedN)) * 1000) / 10
      : 100;
  const prevAiCostUsd = prevAi._sum.aiCostUsd ?? 0;
  const prevRevenueUyu = prevRevenue._sum.totalPriceUyu ?? 0;

  const trends: AdminTrends = {
    labels: trend(rangeLabelsTotal, prevLabelsOkN),
    failed: trend(rangeFailedTotal, prevFailedN),
    successRate: trend(curSuccessRate, prevSuccessRate),
    revenueUyu: trend(roundUyu(revenueRange), roundUyu(prevRevenueUyu)),
    aiCostUsd: trend(roundUsd(rangeAiCostUsd), roundUsd(prevAiCostUsd)),
  };

  const result: AdminMetrics = {
    generatedAt: new Date().toISOString(),
    rangeDays,
    hourlyRangeDays: HOURLY_RANGE_DAYS,

    scopedTenantId: scopeTenantId,
    scopedTenantName,

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

      revenueUyuThisMonth: roundUyu(revenueThisMonth._sum.totalPriceUyu ?? 0),
      revenueUyuLast30Days: roundUyu(revenueRange),
      revenueUyuAllTime: roundUyu(paidPurchasesAllTime._sum.totalPriceUyu ?? 0),
      paidPurchasesLast30Days: paidPurchasesRange.length,
      aovUyuLast30Days: roundUyu(aovUyuRange),

      referralAccrualsAllTime: referralAccrualsTotalsAll._count,
      referralShipmentsAccruedAllTime:
        referralAccrualsTotalsAll._sum.shipmentsAccrued ?? 0,
      refereesActiveCount: refereesCount,
    },

    rangeLabelsTotal,
    rangeFailedTotal,
    trends,

    planDistribution,
    daily,
    revenueDaily,
    hourlyLast7d: hourlyBuckets,

    topTenants,
    problemTenants,

    statusBreakdown30d,
    errorBreakdown30d,
    paymentFailureBreakdown30d,
    aiModelBreakdown30d,
    jobsBreakdown30d,

    geographyTop,
    cityTop,
    paymentTypeBreakdown,
    paymentStatusBreakdown,
    jobTypeBreakdown,
    valueStats,

    labelsByTenant,
    revenueByTenant,

    recentPayments,
    topPayers,
    topReferrers,

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

function trend(current: number, previous: number): AdminTrendMetric {
  const deltaPct =
    previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
  return { current, previous, deltaPct };
}

function subtractDays(now: Date, days: number): Date {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function roundUsd(n: number): number {
  return Math.round(n * 10000) / 10000; // 4 decimals — AI calls are tiny per-call.
}

function roundUyu(n: number): number {
  // UYU is whole-peso for invoice purposes; we keep 2 decimals for averages
  // (AOV) so ".50" doesn't round away. The currency itself has no cents in
  // common usage but DAC tariffs occasionally include them.
  return Math.round(n * 100) / 100;
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

function hourUy(d: Date): number {
  // UY local hour 0..23, derived from the same UTC-3 offset used above.
  const uy = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return uy.getUTCHours();
}

/**
 * Normalize an error message into a "signature" suitable for grouping.
 *
 * The DB has thousands of free-form error strings; we want the dashboard
 * to surface "missing dac credentials" as ONE row regardless of which
 * tenant or order triggered it. So we strip:
 *   - quoted segments ("...", '...')
 *   - parenthesized segments
 *   - long numeric IDs (≥ 4 digits)
 *   - UUIDs and hex tokens (≥ 8 chars)
 *   - URLs
 *   - whitespace runs
 * Then lowercase + truncate to 80 chars. Two messages with the same
 * template after this collapse to the same bucket.
 *
 * Imperfect — a truly novel error can still mismatch — but it gets us
 * actionable "top 10" buckets instead of unreadable noise.
 */
function normalizeErrorMessage(raw: string): string {
  let s = raw;
  // strip URLs
  s = s.replace(/https?:\/\/\S+/gi, '<url>');
  // strip quoted segments (greedy enough; nested quotes are rare in our errors)
  s = s.replace(/"[^"]*"/g, '<q>');
  s = s.replace(/'[^']*'/g, '<q>');
  // strip parenthesized
  s = s.replace(/\([^)]{0,200}\)/g, '<p>');
  // strip UUIDs (8-4-4-4-12)
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  // strip long hex / cuid tokens
  s = s.replace(/\b[a-z0-9]{20,}\b/gi, '<id>');
  // strip long numeric IDs (DAC guías, Shopify order ids, etc.)
  s = s.replace(/\b\d{4,}\b/g, '<n>');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s.slice(0, 80);
}
