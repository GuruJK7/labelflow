/**
 * Shared retry executor — the ONE place that unblocks + re-runs stuck orders.
 *
 * Used by both POST /api/v1/labels/retry-failed (active store) and POST
 * /api/v1/control/retry (any owned store), so the duplicate-shipment safety
 * (only `retryable`-class labels via selectRetryable, plus the worker's C-4
 * PendingShipment guard) can never diverge between the two entry points.
 *
 * CALLERS MUST do auth + ownership + plan-active gating BEFORE calling this.
 * This function does NOT check who you are — it just does the work for the
 * tenantId it is given.
 */

import { db } from '@/lib/db';
import { enqueueProcessOrders, isJobRunning } from '@/lib/queue';
import { reconcileStuckAgainstShopify } from '@/lib/shopify-reconcile';
import { selectRetryable } from '@/lib/stuck-labels';

export interface RetryResult {
  retried: string[];
  count: number;
  jobId: string | null;
  alreadyRunning: boolean;
  message: string;
}

export async function runRetryForTenant(tenantId: string, count: number): Promise<RetryResult> {
  // Drop stale rows (order already resolved in Shopify) BEFORE selecting, so a
  // retry is never wasted on an order that no longer needs shipping.
  try {
    await reconcileStuckAgainstShopify(tenantId);
  } catch {
    // Non-fatal: fall back to the DB-derived candidate set.
  }

  const selected = await selectRetryable(tenantId, count);
  if (selected.length === 0) {
    return {
      retried: [],
      count: 0,
      jobId: null,
      alreadyRunning: false,
      message: 'No hay envios sin completar para reintentar.',
    };
  }

  const labelIds = selected.map((l) => l.id);
  const shopifyOrderIds = selected.map((l) => l.shopifyOrderId);
  const orderNames = selected.map((l) => l.shopifyOrderName);

  // Atomically unblock the selected orders (delete Label + PendingShipment).
  await db.$transaction(async (tx) => {
    await tx.label.deleteMany({ where: { id: { in: labelIds }, tenantId } });
    await tx.pendingShipment.deleteMany({
      where: { tenantId, shopifyOrderId: { in: shopifyOrderIds } },
    });
    await tx.runLog.create({
      data: {
        tenantId,
        jobId: null,
        level: 'INFO',
        message: 'labels-retry-failed',
        meta: {
          count: selected.length,
          requestedCount: count,
          orderNames,
          shopifyOrderIds,
          triggeredBy: 'dashboard-retry-failed',
        },
      },
    });
  });

  // Trigger a run pinned to EXACTLY these orders (targetShopifyOrderIds) so an
  // old stuck order always gets a slot regardless of tenant sort + cap. If a
  // job is already running, skip the enqueue — the in-flight job (or the next
  // scheduled tick) picks the now-unblocked orders up.
  let jobId: string | null = null;
  const running = await isJobRunning(tenantId);
  if (!running) {
    jobId = await enqueueProcessOrders(tenantId, 'MANUAL');
    await db.runLog.create({
      data: {
        jobId,
        tenantId,
        level: 'INFO',
        message: `maxOrdersOverride=${selected.length}`,
        meta: {
          maxOrdersPerRun: selected.length,
          source: 'retry-failed',
          targetShopifyOrderIds: shopifyOrderIds,
        },
      },
    });
  }

  return {
    retried: orderNames,
    count: selected.length,
    jobId,
    alreadyRunning: running,
    message: running
      ? `${selected.length} envio(s) desbloqueado(s). Hay un job en curso: se reintentaran en la proxima corrida.`
      : `Reintentando ${selected.length} envio(s): ${orderNames.join(', ')}.`,
  };
}
