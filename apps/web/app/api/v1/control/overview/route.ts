/**
 * GET /api/v1/control/overview
 *
 * Cross-store operational snapshot for the multi-store control dashboard.
 * Returns, for EVERY store the authenticated user owns: connection health,
 * the "sin completar" breakdown (retryable/orphan/remitente), shipments done
 * today + this month, last run, and live running/queued state. Plus the shared
 * credit wallet and a global queue (the order the single worker drains them).
 *
 * Admin (ADMIN_EMAILS, D32 revisión 2026-09-02): además de las propias, lista
 * TODOS los tenants activos de todos los usuarios (lib/control-scope), cada
 * uno etiquetado con el email del dueño (`owner`), y responde `adminView: true`
 * para que la UI agrupe por dueño. El wallet sigue siendo el del que mira
 * (su propio credit-holder): el saldo de cada cliente no se mezcla. Para un
 * usuario normal la respuesta es exactamente la de siempre.
 *
 * All DB-only (cheap, indexed) so the dashboard can poll it ~every 10s. The
 * "sin completar" counts here are the PRE-reconcile DB numbers (no Shopify call
 * on the fast loop); the throttled /api/v1/control/pending endpoint reconciles
 * each store against Shopify so these counts converge to the single-store
 * widget within one throttle window. The expensive live-Shopify "pendientes"
 * backlog is also that separate endpoint.
 *
 * Privacy: never returns secrets — only boolean connection flags.
 */

import { db } from '@/lib/db';
import { LabelStatus, JobStatus } from '@prisma/client';
import { apiError, apiSuccess } from '@/lib/api-utils';
import { getControlActor, controlTenantWhere } from '@/lib/control-scope';
import { getStuckBreakdown } from '@/lib/stuck-labels';
import { startOfDayUy, startOfMonthUy } from '@/lib/uy-time';

// Job states that mean "this store has work in flight" (same set as
// lib/queue.ts isJobRunning). Typed so a typo'd enum member fails to compile.
const RUNNING_STATUSES: JobStatus[] = [
  JobStatus.PENDING,
  JobStatus.RUNNING,
  JobStatus.WAITING_FOR_AGENT,
  JobStatus.UPLOADING,
];
// Statuses that count as a real, dispatched shipment.
const DONE_STATUSES: LabelStatus[] = [LabelStatus.CREATED, LabelStatus.COMPLETED];

const EMPTY_WALLET = { availableCredits: 0, isActive: false, subscriptionStatus: 'INACTIVE' };

export async function GET() {
  const actor = await getControlActor();
  if (!actor) return apiError('No autorizado', 401);

  const tenants = await db.tenant.findMany({
    where: controlTenantWhere(actor),
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // primer tenant PROPIO = credit holder
    // shopifyToken / dacPassword are encrypted ciphertext, pulled ONLY to derive
    // the *Connected booleans below. NEVER spread `t` into the response, return
    // these fields, or log `tenants` — that would exfiltrate the secrets.
    select: {
      id: true,
      userId: true,
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
      wallet: EMPTY_WALLET,
      queue: [],
      ...(actor.isAdmin ? { adminView: true } : {}),
    });
  }

  // Email del dueño de cada tienda, sólo en la vista admin (para un usuario
  // normal todas son suyas y el campo no existe: la respuesta no cambia).
  const ownerEmailByUserId = new Map<string, string>();
  if (actor.isAdmin) {
    const userIds = Array.from(new Set(tenants.map((t) => t.userId)));
    const owners = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true },
    });
    for (const u of owners) ownerEmailByUserId.set(u.id, u.email);
  }

  const tenantIds = tenants.map((t) => t.id);
  const dayStart = startOfDayUy();
  const monthStart = startOfMonthUy();
  const now = new Date();

  const [doneToday, doneMonth, activeJobs, leases, stuckList] = await Promise.all([
    db.label.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: { in: DONE_STATUSES }, createdAt: { gte: dayStart } },
      _count: true,
    }),
    db.label.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: { in: DONE_STATUSES }, createdAt: { gte: monthStart } },
      _count: true,
    }),
    db.job.findMany({
      where: { tenantId: { in: tenantIds }, status: { in: RUNNING_STATUSES } },
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
  // The lease row points at the SPECIFIC job it was acquired for, so derive
  // "running" per-job (a queued PENDING job for a busy tenant is NOT running).
  const leaseJobIds = new Set(leases.map((l) => l.jobId).filter((id): id is string => !!id));
  const nameById = new Map(tenants.map((t) => [t.id, t.name]));

  // Keep the oldest non-terminal job per tenant as that store's "active" job.
  const activeByTenant = new Map<string, (typeof activeJobs)[number]>();
  for (const j of activeJobs) {
    if (!activeByTenant.has(j.tenantId)) activeByTenant.set(j.tenantId, j);
  }

  const stores = tenants.map((t) => {
    const stuck = stuckByTenant.get(t.id) ?? { count: 0, total: 0, retryable: 0, orphan: 0, remitente: 0, needsAddress: 0 };
    const active = activeByTenant.get(t.id) ?? null;
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      shopifyConnected: !!t.shopifyStoreUrl && !!t.shopifyToken,
      dacConnected: !!t.dacUsername && !!t.dacPassword,
      // Tienda dada de alta desde DEPO (el depósito). El marcador es el slug:
      // `/api/provisioning/dac-tenant` arma `ae-<sellerSlug>` y DEPO manda
      // siempre `depo-<marca>`, así que estas cuentas —y sólo estas— empiezan
      // con `ae-depo-`. No hay columna nueva a propósito: agregar una a Tenant
      // es una migración de Prisma sobre la base de producción para un dato
      // que el slug ya lleva, y el slug es único e inmutable.
      // Las de VentaFlow (`ae-adrijk7-cr`) NO matchean, que es lo correcto.
      depo: typeof t.slug === 'string' && t.slug.startsWith('ae-depo-'),
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
            // True "shipping right now" = this specific job holds a live DAC
            // lease; RUNNING without a lease is starting up or being reconciled.
            leaseActive: leaseJobIds.has(active.id),
          }
        : null,
      ...(actor.isAdmin
        ? {
            owner: {
              email: ownerEmailByUserId.get(t.userId) ?? '—',
              own: t.userId === actor.userId,
            },
          }
        : {}),
    };
  });

  // Global queue across the listed stores, in the order the single shared
  // worker will drain them (Job.createdAt asc). Only a RUNNING job is "running";
  // PENDING/WAITING/UPLOADING are queued. NOTE: the worker also interleaves
  // other users' jobs, so position is order-among-your-stores, not a hard ETA.
  const queue = activeJobs.map((j, i) => ({
    position: i,
    jobId: j.id,
    tenantId: j.tenantId,
    tenantName: nameById.get(j.tenantId) ?? j.tenantId,
    status: j.status,
    trigger: j.trigger,
    running: j.status === JobStatus.RUNNING,
  }));

  // Shared wallet — lives on the credit-holder = oldest tenant OF THE VIEWER.
  // The list is createdAt asc and always includes the viewer's own tenants, so
  // the first one with their userId is their holder; for a user it is
  // tenants[0] (unchanged). An admin who owns no tenant at all has no wallet.
  const holder = tenants.find((t) => t.userId === actor.userId);
  const wallet = holder
    ? {
        availableCredits: (holder.shipmentCredits ?? 0) + (holder.referralBonusCredits ?? 0),
        isActive: holder.isActive,
        subscriptionStatus: holder.subscriptionStatus,
      }
    : EMPTY_WALLET;

  return apiSuccess({
    stores,
    wallet,
    queue,
    ...(actor.isAdmin ? { adminView: true } : {}),
  });
}
