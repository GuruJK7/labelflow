/**
 * GET /api/v1/control/overview
 *
 * Cross-store operational snapshot for the multi-store control dashboard.
 * Returns, for EVERY store the authenticated user owns: connection health,
 * the "sin completar" breakdown (retryable/orphan/remitente), shipments done
 * today + this month, last run, and live running/queued state. Plus the shared
 * credit wallet and a global queue (the order the single worker drains them).
 *
 * All DB-only (cheap, indexed) so the dashboard can poll it ~every 10s. The
 * expensive live-Shopify "pendientes" backlog is a SEPARATE, throttled endpoint
 * (/api/v1/control/pending) so it never rides the fast poll loop.
 *
 * Cross-store, so it uses getAuthenticatedUser() (not the single active tenant).
 * Privacy: never returns secrets — only boolean connection flags.
 */

import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError, apiSuccess } from '@/lib/api-utils';
import { getStuckBreakdown } from '@/lib/stuck-labels';
import { startOfDayUy, startOfMonthUy } from '@/lib/uy-time';

// Job states that mean "this store has work in flight" (same set as
// lib/queue.ts isJobRunning).
const RUNNING_STATUSES = ['PENDING', 'RUNNING', 'WAITING_FOR_AGENT', 'UPLOADING'];
// Statuses that count as a real, dispatched shipment.
const DONE_STATUSES = ['CREATED', 'COMPLETED'];

export async function GET() {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  const tenants = await db.tenant.findMany({
    where: { userId: auth.userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // tenants[0] = credit holder
    select: {
      id: true,
      name: true,
      slug: true,
      shopifyStoreUrl: true,
      shopifyToken: true,
      dacUsername: true,
      dacPassword: true,
      isActive: true,
      subscriptionStatus: true,
      shipmentCredits: true,
      referralBonusCredits: true,
      lastRunAt: true,
      maxOrdersPerRun: true,
    },
  });

  if (tenants.length === 0) {
    return apiSuccess({
      stores: [],
      wallet: { availableCredits: 0, isActive: false, subscriptionStatus: 'INACTIVE' },
      queue: [],
    });
  }

  const tenantIds = tenants.map((t) => t.id);
  const dayStart = startOfDayUy();
  const monthStart = startOfMonthUy();
  const now = new Date();

  const [doneToday, doneMonth, activeJobs, leases, stuckList] = await Promise.all([
    db.label.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: { in: DONE_STATUSES as never }, createdAt: { gte: dayStart } },
      _count: true,
    }),
    db.label.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: { in: DONE_STATUSES as never }, createdAt: { gte: monthStart } },
      _count: true,
    }),
    db.job.findMany({
      where: { tenantId: { in: tenantIds }, status: { in: RUNNING_STATUSES as never } },
      orderBy: { createdAt: 'asc' }, // worker drains oldest-first
      select: {
        id: true,
        tenantId: true,
        status: true,
        trigger: true,
        totalOrders: true,
        successCount: true,
        failedCount: true,
        skippedCount: true,
        startedAt: true,
        createdAt: true,
      },
    }),
    db.dacProcessingLease.findMany({
      where: { tenantId: { in: tenantIds }, expiresAt: { gt: now } },
      select: { tenantId: true, jobId: true },
    }),
    // Per-store stuck breakdown (reconcile-free, single source of truth).
    Promise.all(tenantIds.map((id) => getStuckBreakdown(id))),
  ]);

  const doneTodayByTenant = new Map(doneToday.map((r) => [r.tenantId, r._count]));
  const doneMonthByTenant = new Map(doneMonth.map((r) => [r.tenantId, r._count]));
  const stuckByTenant = new Map(tenantIds.map((id, i) => [id, stuckList[i]]));
  const leaseTenantIds = new Set(leases.map((l) => l.tenantId));
  const nameById = new Map(tenants.map((t) => [t.id, t.name]));

  // Keep the oldest non-terminal job per tenant as that store's "active" job.
  const activeByTenant = new Map<string, (typeof activeJobs)[number]>();
  for (const j of activeJobs) {
    if (!activeByTenant.has(j.tenantId)) activeByTenant.set(j.tenantId, j);
  }

  const stores = tenants.map((t) => {
    const stuck = stuckByTenant.get(t.id) ?? { total: 0, retryable: 0, orphan: 0, remitente: 0 };
    const active = activeByTenant.get(t.id) ?? null;
    const leaseActive = leaseTenantIds.has(t.id);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      shopifyConnected: !!t.shopifyStoreUrl && !!t.shopifyToken,
      dacConnected: !!t.dacUsername && !!t.dacPassword,
      stuck: {
        total: stuck.total,
        retryable: stuck.retryable,
        orphan: stuck.orphan,
        remitente: stuck.remitente,
      },
      doneToday: doneTodayByTenant.get(t.id) ?? 0,
      doneMonth: doneMonthByTenant.get(t.id) ?? 0,
      lastRunAt: t.lastRunAt ? t.lastRunAt.toISOString() : null,
      maxOrdersPerRun: t.maxOrdersPerRun,
      running: active
        ? {
            jobId: active.id,
            status: active.status,
            trigger: active.trigger,
            totalOrders: active.totalOrders,
            successCount: active.successCount,
            failedCount: active.failedCount,
            skippedCount: active.skippedCount,
            startedAt: active.startedAt ? active.startedAt.toISOString() : null,
            // True "shipping right now" = a live DAC lease; RUNNING without a
            // lease is starting up or being reconciled.
            leaseActive,
          }
        : null,
    };
  });

  // Global queue across the user's stores, in the order the single shared
  // worker will drain them (Job.createdAt asc). NOTE: the worker also
  // interleaves other users' jobs, so position is order-among-your-stores,
  // not a hard ETA.
  const queue = activeJobs.map((j, i) => ({
    position: i,
    jobId: j.id,
    tenantId: j.tenantId,
    tenantName: nameById.get(j.tenantId) ?? j.tenantId,
    status: j.status,
    trigger: j.trigger,
    running: j.status === 'RUNNING' || leaseTenantIds.has(j.tenantId),
  }));

  // Shared wallet — lives on the credit-holder = oldest tenant = tenants[0].
  const holder = tenants[0];
  const wallet = {
    availableCredits: (holder.shipmentCredits ?? 0) + (holder.referralBonusCredits ?? 0),
    isActive: holder.isActive,
    subscriptionStatus: holder.subscriptionStatus,
  };

  return apiSuccess({ stores, wallet, queue });
}
