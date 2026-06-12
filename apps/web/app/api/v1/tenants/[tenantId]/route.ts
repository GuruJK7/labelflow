/**
 * PATCH /api/v1/tenants/[tenantId] — rename a store the authenticated user
 * owns. Used by the tenant switcher's inline edit so a user with several
 * stores (all created with the default "Nueva tienda" label) can name them
 * meaningfully ("Karbon Uruguay", "Aura", ...) and tell them apart.
 *
 * DELETE /api/v1/tenants/[tenantId] — permanently delete a store the user owns
 * and everything under it (jobs, labels, run logs, etc.). Heavily guarded:
 * ownership-checked, blocked for the credit-holder (oldest) tenant, the user's
 * only tenant, the currently-active tenant, and any tenant with a run in
 * flight; requires the exact store name echoed back as `confirm`.
 *
 * Ownership lives in the WHERE clause (id + userId) via updateMany, so a
 * tenant owned by another user is indistinguishable from a non-existent one
 * — both return 403, never leaking which tenantIds belong to other accounts.
 * (Same no-leak posture as /api/v1/tenants/switch.)
 *
 * Body: { name: string }  — 1..80 chars after trim (matches the cap POST uses).
 *
 * Privacy: touches only the display `name`. No secrets are read or returned.
 */

import { NextRequest } from 'next/server';
import { JobStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getAuthenticatedUser, getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

// A teardown of a busy store can touch hundreds of thousands of RunLog rows,
// so give the route headroom over the default function timeout. The big
// RunLog purge is chunked (below) to stay well within this even on Hobby.
export const maxDuration = 60;

const MAX_NAME_LEN = 80;

// Jobs in any of these states mean the store has work in flight — refuse to
// delete underneath the worker (same set as lib/queue.ts isJobRunning).
const RUNNING_STATUSES: JobStatus[] = [
  JobStatus.PENDING,
  JobStatus.RUNNING,
  JobStatus.WAITING_FOR_AGENT,
  JobStatus.UPLOADING,
];

// RunLog rows are deleted in chunks so a store with a huge history never
// blows the function timeout or holds one giant lock.
const RUNLOG_CHUNK = 50000;

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  const { tenantId } = await context.params;

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return apiError('Body inválido', 400);
  }

  const name = (body.name ?? '').trim();
  if (name.length === 0) {
    return apiError('El nombre no puede estar vacío', 422);
  }
  if (name.length > MAX_NAME_LEN) {
    return apiError(`El nombre no puede superar ${MAX_NAME_LEN} caracteres`, 422);
  }

  // Ownership is enforced in the filter: only a tenant whose id AND userId
  // both match is touched. count === 0 means "not yours or doesn't exist" —
  // we return the same 403 for both so existence never leaks across accounts.
  const result = await db.tenant.updateMany({
    where: { id: tenantId, userId: auth.userId },
    data: { name },
  });
  if (result.count === 0) {
    return apiError('Tienda no encontrada o no tenés permiso', 403);
  }

  return apiSuccess({ tenant: { id: tenantId, name } });
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
) {
  // Use the tenant-aware session so we can also block deleting the ACTIVE store
  // (its id lives in the JWT; deleting it would leave the session pointing at a
  // ghost tenant until the user switches/re-logs).
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { tenantId } = await context.params;

  // Load all of the user's stores in credit-holder order (createdAt asc, id asc
  // — identical to GET /tenants and /control/overview, so tenants[0] is the
  // holder). One query gives us ownership + the holder + the store count.
  const tenants = await db.tenant.findMany({
    where: { userId: auth.userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });

  const target = tenants.find((t) => t.id === tenantId);
  // Ownership: a tenant that isn't in the user's list is either not theirs or
  // doesn't exist — same 403 for both so existence never leaks across accounts.
  if (!target) {
    return apiError('Tienda no encontrada o no tenés permiso', 403);
  }
  if (tenants.length <= 1) {
    return apiError('No podés eliminar tu única tienda.', 409);
  }
  if (tenants[0].id === tenantId) {
    return apiError(
      'La tienda principal (donde se acumulan tus créditos) no se puede eliminar.',
      409,
    );
  }
  if (auth.tenantId === tenantId) {
    return apiError('Es tu tienda activa. Cambiá de tienda antes de eliminarla.', 409);
  }

  // Don't delete underneath the worker — a run in flight could be writing rows
  // for this tenant right now.
  const runningJob = await db.job.findFirst({
    where: { tenantId, status: { in: RUNNING_STATUSES } },
    select: { id: true },
  });
  if (runningJob) {
    return apiError(
      'La tienda tiene una corrida en curso. Esperá a que termine y volvé a intentar.',
      409,
    );
  }

  // Typed-name confirmation — the destructive backstop against an accidental or
  // mis-targeted delete (mirrors GitHub-style "type the name to confirm").
  let body: { confirm?: string } = {};
  try {
    body = await req.json();
  } catch {
    // fall through to the mismatch error below
  }
  if ((body.confirm ?? '').trim() !== target.name.trim()) {
    return apiError('El nombre de confirmación no coincide.', 422);
  }

  // --- Teardown ---------------------------------------------------------------
  // Tenant has four child relations WITHOUT onDelete:Cascade (Job, Label,
  // RunLog, MetaAdAccount); every other relation cascades. So we delete those
  // four explicitly (FK-safe order: things that reference Job — Label, RunLog —
  // before Job), then tenant.delete() cascades the rest. RunLog can be hundreds
  // of thousands of rows, so it is purged in bounded chunks OUTSIDE the
  // transaction first (idempotent: re-running keys on tenantId), then a final
  // mop-up inside the tx catches any stragglers.
  let removedRunLogs = 0;
  for (let i = 0; i < 1000; i++) {
    // RUNLOG_CHUNK is a hard-coded constant (never user input), inlined as a SQL
    // literal — a bound parameter in LIMIT is needlessly driver-fiddly. Number()
    // guards against any adapter returning the affected-row count as a BigInt.
    const n = Number(
      await db.$executeRaw`
        DELETE FROM "RunLog"
        WHERE id IN (SELECT id FROM "RunLog" WHERE "tenantId" = ${tenantId} LIMIT 50000)
      `,
    );
    removedRunLogs += n;
    if (n < RUNLOG_CHUNK) break;
  }

  let counts: { labels: number; jobs: number };
  try {
    counts = await db.$transaction(
      async (tx) => {
        // Re-check INSIDE the tx: if the worker enqueued/started a run for this
        // tenant during the (non-transactional) RunLog purge above, abort so we
        // never delete a Job row out from under an active run. The throw rolls
        // back this tx; the store survives (only some audit RunLogs were purged).
        const liveJob = await tx.job.findFirst({
          where: { tenantId, status: { in: RUNNING_STATUSES } },
          select: { id: true },
        });
        if (liveJob) throw new Error('ABORT_RUNNING');

        await tx.runLog.deleteMany({ where: { tenantId } }); // stragglers (~0)
        const labels = await tx.label.deleteMany({ where: { tenantId } });
        const jobs = await tx.job.deleteMany({ where: { tenantId } });
        await tx.metaAdAccount.deleteMany({ where: { tenantId } }); // cascades subtree
        // Scalar-tenantId tables with no FK to Tenant — tidy the operational ones
        // so a re-created store starts clean. AuditLog is intentionally NOT
        // deleted: it is append-only forensic history and its tenantId is
        // nullable, so the orphaned rows are harmless and the trail is preserved.
        await tx.pendingShipment.deleteMany({ where: { tenantId } });
        await tx.dacProcessingLease.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } }); // cascades the rest
        return { labels: labels.count, jobs: jobs.count };
      },
      { timeout: 20000 },
    );
  } catch (e) {
    if (e instanceof Error && e.message === 'ABORT_RUNNING') {
      return apiError(
        'La tienda comenzó una corrida mientras se eliminaba. Esperá a que termine y volvé a intentar.',
        409,
      );
    }
    throw e;
  }

  return apiSuccess({
    deleted: {
      id: tenantId,
      name: target.name,
      labels: counts.labels,
      jobs: counts.jobs,
      runLogs: removedRunLogs,
    },
  });
}
