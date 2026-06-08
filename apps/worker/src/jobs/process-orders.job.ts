import { db } from '../db';
import { deductCreditsAndStamp } from '../credits';
import { getCreditHolderTenantId } from '../credit-holder';
import { decryptIfPresent, decryptOrRaw } from '../encryption';
import { getConfig } from '../config';
import { createShopifyClient } from '../shopify/client';
import { getUnfulfilledOrders, markOrderProcessed, addOrderNote } from '../shopify/orders';
import { resolveOrderPhone } from '../shopify/phone';
import { fulfillOrderWithTracking, ShopifyAlreadyFulfilledError, ShopifyMissingScopesError } from '../shopify/fulfillment';
import { dacBrowser } from '../dac/browser';
import { smartLogin } from '../dac/auth';
import { createShipment, mergeAddress, DuplicateSubmitError, DacAddressRejectedError } from '../dac/shipment';
import { reconcileOrphansForTenant } from '../dac/orphan-reconcile';
import { finalizeRecoveredGuiaLabels } from '../dac/finalize-recovered-guias';
import { withTenantDacLock, DacLockHeldError } from '../dac/tenant-lock';
import {
  buildRemitenteShopifyNote,
  REMITENTE_NOTE_DEDUP_PREFIX_LEN,
  REMITENTE_LABEL_MESSAGE,
} from '../dac/remitente-manual';
import { markAddressResolutionFeedback } from '../dac/ai-resolver';
import { buildSafeLabelGeoFields } from './label-safe-fields';
import { getDepartmentForCity, getDepartmentForCityAsync } from '../dac/uruguay-geo';
import { downloadLabel } from '../dac/label';
import { determinePaymentType } from '../rules/payment';
import {
  buildAllowedSet,
  orderMatchesAllowedProducts,
  type ProductCache,
} from '../rules/product-filter';
import { evaluateShippingRules, type ShippingRuleRow } from '../rules/shipping';
import {
  partitionByCompletedLabels,
  partitionByAIFeasibilityBounce,
  partitionByStuckPendingShipment,
} from './order-dedup-filter';
import { sendShipmentNotification } from '../notifier/email';
import { uploadLabelPdf } from '../storage/upload';
import { createStepLogger } from '../logger';
import logger from '../logger';
import { sleep } from '../utils';
import fs from 'fs';
import path from 'path';

const DELAY_BETWEEN_ORDERS_MS = 500;
const MAX_RETRIES_PER_ORDER = 2;

/**
 * Retry wrapper: attempts fn up to maxRetries times with a short delay.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  label: string,
  slog: ReturnType<typeof createStepLogger>
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        slog.info('retry', `Retry attempt ${attempt}/${maxRetries} for ${label}`);
        await sleep(2000);
      }
      return await fn();
    } catch (err) {
      lastError = err as Error;
      slog.warn('retry', `Attempt ${attempt}/${maxRetries} failed for ${label}: ${lastError.message}`);
    }
  }
  throw lastError!;
}

/**
 * Public entry point: acquires the per-tenant DAC processing lease
 * (Fase 3, 2026-04-21 audit) and runs the actual order-processing body.
 *
 * If another worker already holds the lease for this tenant, the job is
 * re-queued to PENDING and a later poll cycle will re-pick it. This
 * prevents two workers from driving DAC for the same credentials at the
 * same time — DAC only permits a single active session per user, and
 * concurrent logins cause login loops, orphan PENDING-* guías, and
 * occasionally real duplicate shipments.
 */
export async function processOrdersJob(tenantId: string, jobId: string): Promise<void> {
  try {
    await withTenantDacLock(tenantId, jobId, () =>
      processOrdersJobInner(tenantId, jobId),
    );
  } catch (err) {
    if (err instanceof DacLockHeldError) {
      logger.warn(
        {
          tenantId,
          jobId,
          heldBy: err.holderId,
          lockExpiresAt: err.expiresAt.toISOString(),
        },
        '[DAC-Lock] Tenant lease busy — re-queueing job to PENDING',
      );
      // Reset the row back to PENDING so the poll loop can re-claim it
      // after the current holder releases. The Job row was already
      // UPDATE'd to RUNNING by `claimPendingJob` (index.ts); undo that.
      // We keep `errorMessage` short so the dashboard sees a readable
      // cause; the next claim will clear it when the job actually runs.
      await db.job
        .update({
          where: { id: jobId },
          data: {
            status: 'PENDING',
            startedAt: null,
            errorMessage: `Deferred: DAC lease held by ${err.holderId}`,
          },
        })
        .catch((updateErr) => {
          logger.error(
            { tenantId, jobId, error: (updateErr as Error).message },
            '[DAC-Lock] Failed to re-queue deferred job — may stay in RUNNING until reconcile',
          );
        });
      return;
    }
    throw err;
  }
}

async function processOrdersJobInner(tenantId: string, jobId: string): Promise<void> {
  const startTime = Date.now();
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let totalOrders = 0;

  const slog = createStepLogger(jobId, tenantId);

  try {
    // Mark job as running
    await db.job.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // Check for maxOrders override in RunLog meta.
    //
    // Override semantics (must match scheduler.ts):
    //   - undefined / no row → no override; use tenant.maxOrdersPerRun
    //   - 0 → "unlimited" (process every available order, capped only by
    //         the live credit balance below)
    //   - N > 0 → cap this run at exactly N orders
    //
    // We extract the override into `maxOrdersOverride: number | undefined`
    // (NOT `?? 0` like before) so we can tell "no override → fall back to
    // tenant default" from "explicit zero → unlimited". The previous `?? 0`
    // collapsed both into 0 and the cap-application logic below treated
    // any 0 as "no override", silently dragging unlimited runs back to
    // tenant.maxOrdersPerRun = 20 (default).
    const overrideLog = await db.runLog.findFirst({
      where: { jobId, message: { contains: 'maxOrdersOverride' } },
      orderBy: { createdAt: 'desc' },
    });
    const overrideMeta = overrideLog?.meta as
      | { maxOrdersPerRun?: number; testMode?: boolean; targetShopifyOrderIds?: unknown }
      | undefined;
    const maxOrdersOverride: number | undefined =
      typeof overrideMeta?.maxOrdersPerRun === 'number' ? overrideMeta.maxOrdersPerRun : undefined;
    const testMode = !!overrideMeta?.testMode;
    // Targeted retry (B): when the dashboard "Reintentar" action unblocks
    // specific stuck orders, it passes their Shopify order ids so we process
    // EXACTLY those, not "N by sort". Normalised to a string[] of digit ids.
    const targetShopifyOrderIds: string[] = Array.isArray(overrideMeta?.targetShopifyOrderIds)
      ? (overrideMeta!.targetShopifyOrderIds as unknown[]).map((v) => String(v)).filter((v) => /^\d+$/.test(v))
      : [];
    if (maxOrdersOverride !== undefined) {
      slog.info(
        'config',
        maxOrdersOverride === 0
          ? 'Max orders override: UNLIMITED (process all available)'
          : `Max orders override: ${maxOrdersOverride}`,
      );
    }
    if (testMode) {
      slog.info('config', 'TEST MODE enabled -- will process but not tag orders in Shopify');
    }

    // STEP 1: Load tenant config and decrypt credentials
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      include: {
        shippingRules: {
          where: { isActive: true },
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!tenant) {
      slog.error('config', 'Tenant not found');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Tenant not found' } });
      return;
    }

    const shopifyUrl = tenant.shopifyStoreUrl;
    const shopifyToken = decryptIfPresent(tenant.shopifyToken);
    const dacUsername = decryptOrRaw(tenant.dacUsername);
    const dacPassword = decryptIfPresent(tenant.dacPassword);

    if (!shopifyUrl || !shopifyToken) {
      slog.error('config', 'Shopify credentials not configured');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing Shopify config' } });
      return;
    }

    if (!dacUsername || !dacPassword) {
      slog.error('config', 'DAC credentials not configured');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing DAC config' } });
      return;
    }

    slog.info('start', 'Starting order processing cycle');

    // STEP 2: Get Shopify orders (with sort direction from tenant settings)
    const shopifyClient = createShopifyClient(shopifyUrl, shopifyToken);
    const orderSortDirection = (tenant.orderSortDirection as 'oldest_first' | 'newest_first') ?? 'oldest_first';
    let orders = await getUnfulfilledOrders(shopifyClient, orderSortDirection);

    slog.info('shopify', `Fetched ${orders.length} unfulfilled orders from Shopify (sort: ${orderSortDirection})`);

    // Targeted retry (B): narrow to exactly the unblocked orders. Intersecting
    // with the unfulfilled+paid+open fetch is deliberate — it guarantees we
    // never re-ship an order that got fulfilled in the meantime. Any target not
    // present is logged, never silently dropped (it was already resolved, or
    // sits beyond the 250-order fetch window).
    if (targetShopifyOrderIds.length > 0) {
      const targetSet = new Set(targetShopifyOrderIds);
      const beforeTarget = orders.length;
      const present = orders.filter((o) => targetSet.has(String(o.id)));
      const missing = targetShopifyOrderIds.filter((id) => !present.some((o) => String(o.id) === id));
      orders = present;
      slog.info(
        'targeted-retry',
        `Targeted retry: ${present.length}/${targetShopifyOrderIds.length} target order(s) found in the ${beforeTarget} unfulfilled fetched.${
          missing.length
            ? ` Not shippable now (already fulfilled/closed, or beyond the 250-order fetch window): ${missing.join(', ')}`
            : ''
        }`,
      );
    }

    // ── 2026-04-22 HOTFIX (double-shipping incident) ──────────────────────
    // The prior "Shopify unfulfilled = source of truth, always reprocess"
    // design assumed our own Shopify fulfillment POST succeeds after every
    // successful DAC guía. In prod it does not: `fulfillOrderWithTracking`
    // throws "No fulfillable orders" and `addOrderTag` returns 403 (both
    // logged as non-fatal). The order stays unfulfilled in Shopify, the
    // picker returns it again on the next cron tick, and the worker mints
    // a second DAC guía — DAC bills the tenant twice.
    //
    // Skip rule: if ANY tenant pointing at the SAME shopifyStoreUrl has a
    // COMPLETED Label (with a real, non-PENDING guía) for this order, skip
    // the order — the DB says we already shipped it. Cross-tenant scope is
    // load-bearing: when two tenants share a shop (intentionally, or after
    // an operator-driven re-OAuth), each tenant only sees its own Labels in
    // the per-tenant query, so an order Alex-tenant fulfilled would get
    // re-fulfilled by NuevaTienda-tenant on the next cron — DAC billed twice.
    //
    // Operator redo workflow: use the dashboard "Reenviar" action (or
    // manually delete Label + PendingShipment rows). Deleting the Label
    // row removes the skip condition — the order flows through on the
    // next cron tick. No tag/TTL gymnastics.
    //
    // Design choice: indefinite skip (no TTL). A time-based escape hatch
    // would re-open the duplication window exactly when the
    // Shopify-fulfill bug is unfixed — the failure window has no upper
    // bound until the root cause (missing fulfillment_orders scopes) is
    // resolved on the Shopify app side.
    const sharedTenantIds = tenant.shopifyStoreUrl
      ? (await db.tenant.findMany({
          where: { shopifyStoreUrl: tenant.shopifyStoreUrl },
          select: { id: true },
        })).map((t) => t.id)
      : [tenantId];
    const existingCompletedLabels = await db.label.findMany({
      where: {
        tenantId: { in: sharedTenantIds },
        status: 'COMPLETED',
        NOT: { dacGuia: { startsWith: 'PENDING-' } },
      },
      select: { shopifyOrderId: true, dacGuia: true, updatedAt: true, tenantId: true },
    });

    const beforeCompletedSkip = orders.length;
    const partitioned = partitionByCompletedLabels(orders, existingCompletedLabels, tenantId);
    orders = partitioned.kept;
    const completedSkipped = partitioned.skipped;
    if (completedSkipped.length > 0) {
      const crossTenant = completedSkipped.filter((s) => !s.sameTenant).length;
      const crossTenantNote = crossTenant > 0
        ? ` ${crossTenant} of these were processed by another tenant pointing at the same shop — cross-tenant skip prevented duplicate DAC shipments.`
        : '';
      slog.warn(
        'filter',
        `Skipped ${completedSkipped.length} unfulfilled order(s) with a COMPLETED Label already in DB (prevents duplicate DAC shipments).${crossTenantNote} If Shopify still shows them as unfulfilled, the Shopify fulfillment POST is failing — investigate the Shopify app scopes (read/write_assigned_fulfillment_orders, read/write_merchant_managed_fulfillment_orders). To force a redo, use the dashboard "Reenviar" action or delete the Label + PendingShipment rows.`,
        { skipped: completedSkipped.slice(0, 10), totalSkipped: completedSkipped.length, crossTenantSkipped: crossTenant, beforeCompletedSkip, sharedTenantIds },
      );
    }

    // ── AI-feasibility bounce skip (2026-05-09 cost fix) ─────────────────
    //
    // Audit on 2026-05-09 found that ~98% of daily AI feasibility spend
    // (~$8/day) was wasted re-evaluating the same NEEDS_REVIEW orders every
    // 15-min cron tick. Each bounce produces a Label.errorMessage like
    // "Dirección del cliente en Shopify no se pudo interpretar — contactar al
    // cliente para corregirla y reprocesar". The same Shopify address
    // produces the same AI verdict, so re-asking is wasted spend.
    //
    // This filter skips those orders UNTIL the operator edits the address1
    // in Shopify (which makes the comparison miss → the order flows through
    // again). All OTHER NEEDS_REVIEW reasons (C-4 ORPHANED, REMITENTE
    // manual, possible orphan guía, PDF upload failure) are NOT skipped here
    // — they have separate gates downstream.
    //
    // Cross-tenant scope: same as the COMPLETED filter. A bounce in a sibling
    // tenant pointing at the same shop counts as "we already evaluated this
    // address" — no need for the second tenant to re-burn AI.
    const aiFeasibilityBounces = await db.label.findMany({
      where: {
        tenantId: { in: sharedTenantIds },
        status: 'NEEDS_REVIEW',
        errorMessage: { contains: 'no se pudo interpretar' },
      },
      select: {
        shopifyOrderId: true,
        deliveryAddress: true,
        errorMessage: true,
        updatedAt: true,
        tenantId: true,
      },
    });
    const currentAddress1ByOrderId = new Map<string, string>(
      orders.map((o) => [String(o.id), o.shipping_address?.address1 ?? ''] as const),
    );
    const beforeStuckSkip = orders.length;
    const stuckPartition = partitionByAIFeasibilityBounce(
      orders,
      aiFeasibilityBounces,
      currentAddress1ByOrderId,
      tenantId,
    );
    orders = stuckPartition.kept;
    const stuckSkipped = stuckPartition.skipped;
    if (stuckSkipped.length > 0) {
      const crossTenantStuck = stuckSkipped.filter((s) => !s.sameTenant).length;
      slog.info(
        'filter',
        `Skipped ${stuckSkipped.length} order(s) previously bounced by AI feasibility (same Shopify address1 → same verdict; would burn ~$${(stuckSkipped.length * 0.0045).toFixed(3)} re-asking AI). To force a re-evaluation, edit the address in Shopify or delete the Label row.`,
        {
          skipped: stuckSkipped.slice(0, 10).map((s) => ({ order: s.orderName, sameTenant: s.sameTenant })),
          totalSkipped: stuckSkipped.length,
          crossTenantStuckSkipped: crossTenantStuck,
          beforeStuckSkip,
        },
      );
    }

    // ── Stuck PendingShipment skip (2026-05-11) ──────────────────────────
    //
    // Incident: Nueva tienda had 5 orders stuck in ORPHANED status for ~66h.
    // The C-4 guard inside shipment.ts blocked them on every cron tick (safe
    // default — orphan guía in DAC might exist), but Shopify still showed
    // them unfulfilled, so newest_first fetch pulled them again, the 5-order
    // batch cap took all 5 of them, every cycle returned 0 success / 5
    // failed. Real new orders never got a slot.
    //
    // Fix: at the FILTER level, skip orders with PENDING/ORPHANED
    // PendingShipment so they don't consume batch capacity. The C-4 guard
    // inside shipment.ts is kept as defence-in-depth — it just rarely needs
    // to fire now.
    //
    // Operator unblocks via:
    //   1. Dashboard "Reenviar" action (deletes PendingShipment + Label)
    //   2. Manual SQL: DELETE FROM "PendingShipment" WHERE id = '...'
    //   3. Cancelling the Shopify order (it falls off the unfulfilled list)
    //
    // Scope: tenant-local only. PendingShipment.tenantId is unique per
    // (tenant, shopifyOrderId), so cross-tenant doesn't apply here.
    const stuckPendingShipments = await db.pendingShipment.findMany({
      where: {
        tenantId,
        status: { in: ['PENDING', 'ORPHANED'] },
        shopifyOrderId: { in: orders.map((o) => String(o.id)) },
      },
      select: {
        shopifyOrderId: true,
        status: true,
        resolvedGuia: true,
        submitAttemptedAt: true,
      },
    });
    const beforeStuckPendingSkip = orders.length;
    // Cast: the where-clause restricts to PENDING/ORPHANED but Prisma's
    // return type still has the full enum. Runtime filter is authoritative.
    const stuckPendingPartition = partitionByStuckPendingShipment(
      orders,
      stuckPendingShipments as Array<{
        shopifyOrderId: string;
        status: 'PENDING' | 'ORPHANED';
        resolvedGuia: string | null;
        submitAttemptedAt: Date;
      }>,
    );
    orders = stuckPendingPartition.kept;
    const stuckPendingSkipped = stuckPendingPartition.skipped;
    if (stuckPendingSkipped.length > 0) {
      const oldestHours = Math.max(...stuckPendingSkipped.map((s) => s.ageMs / 3_600_000));
      slog.warn(
        'filter',
        `Skipped ${stuckPendingSkipped.length} order(s) blocked by C-4 (PendingShipment status=PENDING/ORPHANED, oldest=${oldestHours.toFixed(1)}h). These need OPERATOR reconciliation — check DAC historial for an orphan guía and either link it or delete the PendingShipment row via the dashboard "Reenviar" action. Until then they will NOT consume batch slots, so new orders can flow through.`,
        {
          skipped: stuckPendingSkipped.slice(0, 10).map((s) => ({
            order: s.orderName,
            status: s.status,
            guia: s.guia,
            ageHours: Number((s.ageMs / 3_600_000).toFixed(1)),
          })),
          totalSkipped: stuckPendingSkipped.length,
          beforeStuckPendingSkip,
        },
      );
    }

    // Product filter: only process orders containing whitelisted products.
    // The whitelist matches against the cache entry's title, type, or vendor —
    // see apps/worker/src/rules/product-filter.ts for the full contract.
    // Read fresh from DB to avoid stale Prisma client cache.
    let allowedProductTypes: string[] | null = tenant.allowedProductTypes as string[] | null;
    let productTypeCache: ProductCache | null = tenant.productTypeCache as ProductCache | null;
    try {
      const fresh = await db.$queryRaw<{allowedProductTypes: string | null; productTypeCache: string | null}[]>`
        SELECT "allowedProductTypes"::text, "productTypeCache"::text FROM "Tenant" WHERE id = ${tenantId}
      `;
      if (fresh[0]) {
        allowedProductTypes = fresh[0].allowedProductTypes ? JSON.parse(fresh[0].allowedProductTypes) : null;
        productTypeCache = fresh[0].productTypeCache ? JSON.parse(fresh[0].productTypeCache) : null;
      }
    } catch { /* fallback to tenant object values */ }
    slog.info('filter', `Product filter: ${allowedProductTypes && allowedProductTypes.length > 0 ? allowedProductTypes.join(', ') : 'ALL (no filter)'}`);

    if (allowedProductTypes && allowedProductTypes.length > 0 && (!productTypeCache || Object.keys(productTypeCache).length === 0)) {
      slog.warn('filter', `Product filter configured (${allowedProductTypes.join(', ')}) but no product cache — run "Escanear Shopify" first. Processing ALL orders.`);
    }
    if (allowedProductTypes && allowedProductTypes.length > 0 && productTypeCache && Object.keys(productTypeCache).length > 0) {
      const beforeProductFilter = orders.length;
      const allowedSet = buildAllowedSet(allowedProductTypes);
      orders = orders.filter((order) => orderMatchesAllowedProducts(order, allowedSet, productTypeCache!));
      const productFiltered = beforeProductFilter - orders.length;
      if (productFiltered > 0) {
        slog.info('filter', `Product filter: excluded ${productFiltered} orders (allowed: ${allowedProductTypes.join(', ')})`);
      }
    }

    totalOrders = orders.length;

    if (orders.length === 0) {
      slog.info('complete', 'No pending orders found');
      await db.job.update({
        where: { id: jobId },
        data: { status: 'COMPLETED', totalOrders: 0, finishedAt: new Date(), durationMs: Date.now() - startTime },
      });
      return;
    }

    // Apply limit (override from UI takes priority over tenant default).
    //
    // Three cases:
    //   1. override === 0 → UNLIMITED, skip the slice entirely.
    //      Credit gate below will still cap to live balance.
    //   2. override > 0 → cap at that exact count.
    //   3. override === undefined → fall back to tenant.maxOrdersPerRun
    //      (legacy default, currently 20).
    //
    // tenant.maxOrdersPerRun is also honored as 0 = unlimited so a tenant
    // can set its own default to "no cap" without needing scheduleSlots.
    const effectiveLimit: number =
      maxOrdersOverride !== undefined ? maxOrdersOverride : tenant.maxOrdersPerRun;
    const isUnlimited = effectiveLimit === 0;
    if (!isUnlimited && orders.length > effectiveLimit) {
      skippedCount = orders.length - effectiveLimit;
      orders = orders.slice(0, effectiveLimit);
      slog.warn('limit', `Limited to ${effectiveLimit} orders, ${skippedCount} skipped`);
    } else if (isUnlimited) {
      slog.info('limit', `UNLIMITED run: processing all ${orders.length} pending orders (subject to credit balance)`);
    }

    // ── CREDIT-PACK GATE ──
    //
    // Cap orders al saldo de envíos del tenant. El scheduler ya filtra
    // tenants con shipmentCredits > 0, pero acá refrescamos por si el
    // saldo cambió entre el encolado y el inicio del run, y para evitar
    // procesar más órdenes que envíos disponibles dentro de un solo run.
    //
    // Diseño defensivo: si por alguna razón shipmentCredits = 0 al
    // momento del run (race condition entre múltiples jobs en cola, lease
    // expirado, etc.), abortamos limpiamente — DAC no se factura, no se
    // imprime nada, el job queda en COMPLETED con 0 órdenes y el
    // scheduler no volverá a encolar hasta que el tenant compre un pack.
    //
    // Audit 2026-05-08 — multi-store credit pool. Wallet lives on the
    // user's CREDIT-HOLDER tenant (oldest). For non-holder tenants the
    // local shipmentCredits is always 0 by design (welcome bonus
    // suppressed at create-time, all incoming credit lands on holder).
    // We must read the holder's balance to gate, otherwise the new
    // store always aborts with "saldo=0" even when the user has a
    // healthy wallet on Curvadivina.
    const holderId = await getCreditHolderTenantId(tenantId);
    const liveCredits = await db.tenant.findUnique({
      where: { id: holderId },
      select: { shipmentCredits: true, referralBonusCredits: true },
    });
    const availableCredits =
      (liveCredits?.shipmentCredits ?? 0) + (liveCredits?.referralBonusCredits ?? 0);
    if (availableCredits <= 0) {
      slog.warn(
        'credits',
        `Tenant sin créditos al iniciar el run (saldo=${availableCredits}). Abortando sin procesar.`,
      );
      await db.job.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          totalOrders: 0,
          errorMessage: 'Sin créditos disponibles. Comprá un pack para continuar.',
          finishedAt: new Date(),
          durationMs: Date.now() - startTime,
        },
      });
      return;
    }
    if (orders.length > availableCredits) {
      const droppedByCredits = orders.length - availableCredits;
      skippedCount += droppedByCredits;
      orders = orders.slice(0, availableCredits);
      slog.warn(
        'credits',
        `Saldo de ${availableCredits} envíos: limitando a ${orders.length} órdenes, ${droppedByCredits} aplazadas hasta próxima recarga.`,
      );
    }

    // STEP 3: Start browser and login to DAC
    slog.info('dac-login', 'Starting browser and logging into DAC');
    const page = await dacBrowser.getPage();
    try {
      await smartLogin(page, dacUsername, dacPassword, tenantId);
      slog.success('dac-login', 'DAC login successful');
    } catch (err) {
      slog.error('dac-login', `DAC login failed: ${(err as Error).message}`);
      await dacBrowser.close();
      await db.job.update({
        where: { id: jobId },
        data: { status: 'FAILED', totalOrders, errorMessage: 'DAC login failed', finishedAt: new Date(), durationMs: Date.now() - startTime },
      });
      return;
    }

    // STEP 3.5: Orphan-PendingShipment auto-reconcile (2026-05-12).
    //
    // Best-effort pass that uses the same logged-in DAC session to scan
    // historial for ORPHANED PendingShipments. Each one is either RESOLVED
    // (guía found → linked on Label, next cycle does PDF + Shopify
    // fulfill) or RESET-FOR-RETRY (no guía → PendingShipment deleted, Label
    // back to PENDING → next cycle ships fresh). See dac/orphan-reconcile.ts
    // for the full contract.
    //
    // Wrapped in try/catch so a historial-scan failure can't take down the
    // whole cycle — the main processing path runs regardless. Worst case
    // the orphans stay ORPHANED and the next cycle retries this pass.
    try {
      await reconcileOrphansForTenant(page, tenantId, slog);
    } catch (orphanErr) {
      slog.warn(
        'orphan-reconcile',
        `Orphan reconcile pass threw — leaving orphans untouched, continuing with main cycle: ${(orphanErr as Error).message}`,
      );
    }

    // STEP 4: Process each order sequentially with retry
    const config = getConfig();
    const tmpDir = path.join(config.LABELS_TMP_DIR, new Date().toISOString().split('T')[0]);

    // STEP 4.0: Finalize "recovered orphan" labels stuck FAILED with a real guía
    // but no PDF (see dac/finalize-recovered-guias.ts). Runs on the already
    // logged-in DAC session right after orphan-reconcile, so a guía recovered in
    // THIS pass is finalized the same cycle instead of waiting for a re-fetch
    // that may never reach it. Best-effort + flag-gated
    // (DAC_FINALIZE_RECOVERED_GUIA, default OFF) so it can never disrupt the main
    // path. Downloads the EXISTING guía's PDF only — it never re-submits a form,
    // and once COMPLETED partitionByCompletedLabels blocks any duplicate.
    try {
      const fin = await finalizeRecoveredGuiaLabels({
        page,
        tenantId,
        slog,
        tmpDir,
        dacUsername,
        dacPassword,
        shopifyClient,
        enabledTenantsEnv: process.env.DAC_FINALIZE_RECOVERED_GUIA,
      });
      if (fin.finalized > 0 || fin.failed > 0) {
        slog.info('finalize-recovered', `Recovered-guía finalize: ${fin.finalized} completed, ${fin.failed} still pending PDF (of ${fin.scanned} scanned).`);
      }
    } catch (finErr) {
      slog.warn('finalize-recovered', `Finalize sweep threw — continuing with main cycle: ${(finErr as Error).message}`);
    }

    // Load ALL existing guias from DB to prevent picking old guias from DAC historial
    const existingGuias = await db.label.findMany({
      where: { tenantId, dacGuia: { not: null } },
      select: { dacGuia: true },
    });
    const usedGuias = new Set<string>(
      existingGuias.map(l => l.dacGuia!).filter(g => !g.startsWith('PENDING-'))
    );
    slog.info('guia-protection', `Loaded ${usedGuias.size} existing guias from DB to prevent re-assignment`);

    // H-7 (2026-04-21 audit): batch-load the Label rows for every order in this
    // cycle into an in-memory Map. The inner per-order path previously did one
    // `findUnique` per iteration to check for a PRIOR guia from a failed run —
    // 100 orders → 100 extra DB round-trips. For a single-writer worker that's
    // survivable, but under concurrent workers (C-6 fix will enable this soon)
    // it becomes a connection-pool bottleneck, and the query is trivially
    // batchable through the (tenantId, shopifyOrderId) unique index.
    const orderIdStrs = orders.map(o => String(o.id));
    const priorLabels = orderIdStrs.length > 0
      ? await db.label.findMany({
          where: { tenantId, shopifyOrderId: { in: orderIdStrs } },
          select: { shopifyOrderId: true, dacGuia: true, status: true },
        })
      : [];
    const priorLabelByOrderId = new Map<string, { dacGuia: string | null; status: string }>(
      priorLabels.map(l => [l.shopifyOrderId, { dacGuia: l.dacGuia, status: l.status }]),
    );
    slog.info('label-preload', `Preloaded ${priorLabels.length} prior labels for this batch (out of ${orderIdStrs.length} orders)`);

    // 2026-04-22 — auto-pay with stored card (Plexo saved-card + CVC) was
    // REMOVED. Storing CVC is a PCI DSS 3.2 violation, and REMITENTE orders
    // that require Plexo payment now get a Shopify note instead, asking the
    // operator to load the shipment manually in DAC. The gateway, brand, and
    // last4 tenant fields are intentionally left in the schema for rollback
    // safety but are no longer read here.
    //
    // See the REMITENTE early-skip branch below for the new behavior.

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const addr = order.shipping_address;
      const customerName = addr ? `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente' : 'Sin datos';

      slog.info('order-start', `Processing order ${i + 1}/${orders.length}: ${order.name}`, {
        orderId: order.id,
        orderName: order.name,
        customer: customerName,
        city: addr?.city,
      });

      // Validate address
      if (!addr || !addr.address1) {
        // BUG FIX 5: Upsert instead of create to handle retries of FAILED labels
        await db.label.upsert({
          where: {
            tenantId_shopifyOrderId: { tenantId, shopifyOrderId: String(order.id) },
          },
          create: {
            tenantId, jobId,
            shopifyOrderId: String(order.id),
            shopifyOrderName: order.name,
            customerName,
            customerEmail: order.email,
            deliveryAddress: '', city: '', department: '',
            totalUyu: parseFloat(order.total_price) || 0,
            paymentType: 'DESTINATARIO',
            status: 'FAILED',
            errorMessage: 'No shipping address',
          },
          update: {
            jobId,
            status: 'FAILED',
            errorMessage: 'No shipping address',
          },
        }).catch(() => {});

        await addOrderNote(shopifyClient, order.id, 'LabelFlow ERROR: No shipping address').catch(() => {});
        slog.error('order-validate', `Order ${order.name} skipped: no shipping address`);
        failedCount++;
        continue;
      }

      let result: {
        guia: string;
        trackingUrl?: string;
        screenshotPath?: string;
        aiResolutionHash?: string;
        paymentStatus?: 'paid' | 'pending_manual' | 'failed_rejected' | 'not_required';
        paymentFailureReason?: string;
      } | undefined;
      try {
        // a) Determine payment type
        //
        // Evaluation order:
        //   1) ShippingRule rows (new rule engine) — first-match-wins → REMITENTE
        //   2) Legacy path: determinePaymentType(threshold) + consolidateConsecutiveOrders
        //
        // If a tenant has no rules (or none match), the legacy fields still apply
        // unchanged, so pre-existing behavior is preserved.
        let paymentType: 'REMITENTE' | 'DESTINATARIO';

        const ruleResult = await evaluateShippingRules(
          tenant.shippingRules as unknown as ShippingRuleRow[],
          { order, tenantId, db },
        );

        if (ruleResult.paymentType === 'REMITENTE' && ruleResult.matchedRule) {
          paymentType = 'REMITENTE';
          slog.info(
            'order-payment',
            `ShippingRule matched: "${ruleResult.matchedRule.name}" (${ruleResult.matchedRule.ruleType}) → REMITENTE`,
            { orderName: order.name },
          );
        } else {
          // Legacy path — unchanged
          paymentType = determinePaymentType(order, tenant.paymentThreshold, tenant.paymentRuleEnabled);

          if (tenant.consolidateConsecutiveOrders && order.email) {
            const windowMs = (tenant.consolidationWindowMinutes ?? 30) * 60 * 1000;
            const windowStart = new Date(Date.now() - windowMs);
            const priorOrder = await db.label.findFirst({
              where: {
                tenantId,
                customerEmail: order.email,
                status: { in: ['PENDING', 'COMPLETED', 'CREATED'] },
                shopifyOrderId: { not: String(order.id) },
                createdAt: { gte: windowStart },
              },
              orderBy: { createdAt: 'desc' },
            });
            if (priorOrder) {
              paymentType = 'REMITENTE';
              slog.info('order-payment', `Consolidation: customer ${order.email} has prior order ${priorOrder.shopifyOrderName} within ${tenant.consolidationWindowMinutes}min window — overriding to REMITENTE`);
            }
          }
        }

        slog.info('order-payment', `Payment type: ${paymentType}`, { orderName: order.name });

        // ─ 2026-04-22 — REMITENTE handoff ────────────────────────────────────
        //
        // REMITENTE = the store pays upfront via Plexo (saved card + CVC).
        // We REMOVED the auto-pay flow (PCI concern + hung sessions on Plexo
        // when payment couldn't complete). Instead, when a rule marks an
        // order as REMITENTE we skip DAC entirely and leave a Spanish note on
        // the Shopify order telling the operator to load the shipment by
        // hand in DAC.
        //
        // The Label is upserted to NEEDS_REVIEW so: (a) the dashboard shows
        // it in the review column, and (b) the next cycle recognizes it as
        // already-handled and does NOT re-write the Shopify note (dedup is
        // enforced both ways: Label status check + note-prefix substring).
        if (paymentType === 'REMITENTE') {
          const { fullAddress: remMergedAddr } = mergeAddress(addr.address1, addr.address2);
          const remDeptRaw = await getDepartmentForCityAsync(addr.city);
          const { safeCity: remSafeCity, safeDepartment: remSafeDept } = buildSafeLabelGeoFields({
            city: addr.city,
            province: addr.province,
            resolvedDepartment: remDeptRaw,
          });
          const totalUyuNum = parseFloat(order.total_price) || 0;

          await db.label.upsert({
            where: {
              tenantId_shopifyOrderId: { tenantId, shopifyOrderId: String(order.id) },
            },
            create: {
              tenantId, jobId,
              shopifyOrderId: String(order.id),
              shopifyOrderName: order.name,
              customerName,
              customerEmail: order.email,
              customerPhone: resolveOrderPhone(order) ?? addr.phone,
              deliveryAddress: remMergedAddr,
              city: remSafeCity,
              department: remSafeDept,
              totalUyu: totalUyuNum,
              paymentType: 'REMITENTE',
              status: 'NEEDS_REVIEW',
              errorMessage: REMITENTE_LABEL_MESSAGE,
            },
            update: {
              jobId,
              paymentType: 'REMITENTE',
              status: 'NEEDS_REVIEW',
              errorMessage: REMITENTE_LABEL_MESSAGE,
            },
          }).catch(() => {});

          // Idempotent Shopify note — skip if the same prefix is already on the
          // order (same dedup shape as the DacAddressRejectedError path).
          const remNote = buildRemitenteShopifyNote(totalUyuNum);
          try {
            const { data } = await shopifyClient.get(`/orders/${order.id}.json`);
            const currentNote: string = data.order?.note ?? '';
            if (!currentNote.includes(remNote.substring(0, REMITENTE_NOTE_DEDUP_PREFIX_LEN))) {
              await addOrderNote(shopifyClient, order.id, remNote);
              slog.info('order-remitente', `Shopify note added — operator must load ${order.name} manually in DAC`, {
                orderName: order.name,
                totalUyu: totalUyuNum,
              });
            } else {
              slog.info('order-remitente', `Shopify note already present for ${order.name} — skipping note write (dedup)`, {
                orderName: order.name,
              });
            }
          } catch (noteErr) {
            slog.warn('order-remitente', `Could not write REMITENTE note for ${order.name}: ${(noteErr as Error).message}`, {
              orderName: order.name,
            });
          }

          skippedCount++;
          if (i < orders.length - 1) await sleep(DELAY_BETWEEN_ORDERS_MS);
          continue;
        }

        // b) Check if this order already has a REAL guia from a previous failed attempt
        //    This prevents creating DUPLICATE DAC shipments when the DB write failed before.
        //
        // H-7: read from the pre-loaded Map instead of issuing a fresh `findUnique`
        // per order. The Map was populated once at job start via a single
        // `findMany WHERE shopifyOrderId IN (...)` query — same result, O(1) lookup.
        const existingLabel = priorLabelByOrderId.get(String(order.id));

        if (existingLabel?.dacGuia && !existingLabel.dacGuia.startsWith('PENDING-') && existingLabel.status === 'FAILED') {
          // This order already has a real DAC guia from a previous run that failed downstream.
          // A human would NOT re-submit the DAC form — they would continue from where it failed.
          slog.warn('order-shipment', `Order ${order.name} already has guia ${existingLabel.dacGuia} from a failed run — skipping DAC form, reusing guia`);
          result = { guia: existingLabel.dacGuia };
          usedGuias.add(result.guia);
        } else {
          // Create shipment in DAC (NO full-form retry — guia extraction retries internally)
          // Re-submitting the entire form on error creates DUPLICATE shipments in DAC.
          // Only DESTINATARIO orders reach this branch — REMITENTE short-circuited above.
          result = await createShipment(
            page,
            order,
            paymentType,
            dacUsername,
            dacPassword,
            tenantId,
            jobId,
            usedGuias,
            undefined, // addressOverride
            undefined, // autoPay
            { skuInObservations: tenant.skuInObservations },
          );

          // Track this guia so it won't be assigned to another order in this batch
          if (result.guia && !result.guia.startsWith('PENDING-')) {
            usedGuias.add(result.guia);
          }
        }

        slog.success('order-shipment', `DAC shipment created for ${order.name}`, { guia: result.guia });

        // c) Create or update label record in DB (upsert to handle retries of FAILED labels)
        //
        // Label.city and Label.department are REQUIRED (non-null) in Prisma. Use the
        // buildSafeLabelGeoFields helper to guarantee non-null values — see
        // apps/worker/src/jobs/label-safe-fields.ts for the full history on why this
        // matters (hint: null causes a misleading "Argument tenant is missing" error
        // and leaks DAC guias on every cron retry).
        const { fullAddress: mergedAddr } = mergeAddress(addr.address1, addr.address2);
        const resolvedDeptRaw = await getDepartmentForCityAsync(addr.city);
        const { safeCity, safeDepartment: resolvedDept } = buildSafeLabelGeoFields({
          city: addr.city,
          province: addr.province,
          resolvedDepartment: resolvedDeptRaw,
        });
        // Persist the payment outcome alongside the label. REMITENTE is now
        // short-circuited before this block, so every order that reaches here
        // is DESTINATARIO and `result.paymentStatus` defaults to 'not_required'.
        // The paymentAttemptedAt column is left null (no auto-pay attempt).
        const resolvedPaymentStatus = result.paymentStatus ?? 'not_required';
        const resolvedPaymentFailureReason = result.paymentFailureReason ?? null;
        const paymentAttemptedAt: Date | null = null;

        const labelRecord = await db.label.upsert({
          where: {
            tenantId_shopifyOrderId: { tenantId, shopifyOrderId: String(order.id) },
          },
          create: {
            tenantId, jobId,
            shopifyOrderId: String(order.id),
            shopifyOrderName: order.name,
            customerName,
            customerEmail: order.email,
            customerPhone: resolveOrderPhone(order) ?? addr.phone,
            deliveryAddress: mergedAddr,
            city: safeCity,
            department: resolvedDept,
            totalUyu: parseFloat(order.total_price) || 0,
            paymentType,
            paymentStatus: resolvedPaymentStatus,
            paymentFailureReason: resolvedPaymentFailureReason,
            paymentAttemptedAt,
            dacGuia: result.guia,
            status: 'CREATED',
          },
          update: {
            jobId,
            dacGuia: result.guia,
            status: 'CREATED',
            errorMessage: null,
            paymentStatus: resolvedPaymentStatus,
            paymentFailureReason: resolvedPaymentFailureReason,
            paymentAttemptedAt,
            // M-2: a DAC-accepted retry means the transient-error streak
            // ended; zero the counter so a later unrelated blip gets the
            // full MAX_AUTO_RETRIES budget again.
            autoRetryCount: 0,
          },
        });

        slog.info('order-db', `Label record saved: ${labelRecord.id}`, {
          guia: result.guia,
          paymentStatus: resolvedPaymentStatus,
        });

        // 2026-04-22 — removed the auto-pay post-success "pago DAC PENDIENTE"
        // note. REMITENTE orders never reach this point anymore (they are
        // short-circuited above with their own Shopify note), and
        // DESTINATARIO orders never require payment at this stage.

        // d) Download PDF label (skip if guia is temporary/pending).
        // pdfUploaded tracks whether the PDF made it to S3 — read by the
        // billing guard right before successCount++. Two attempts to absorb
        // transient S3/network blips before declaring it failed.
        let pdfUploaded = false;
        if (result.guia && !result.guia.startsWith('PENDING-')) {
          for (let attempt = 1; attempt <= 2 && !pdfUploaded; attempt++) {
            try {
              slog.info('order-pdf', `Downloading PDF for guia ${result.guia}${attempt > 1 ? ` (retry ${attempt})` : ''}`);
              const labelLocalPath = await downloadLabel(page, result.guia, tmpDir, dacUsername, dacPassword);
              if (labelLocalPath && fs.existsSync(labelLocalPath)) {
                const pdfBuffer = fs.readFileSync(labelLocalPath);
                const upload = await uploadLabelPdf(tenantId, labelRecord.id, pdfBuffer);
                if (!upload.error) {
                  await db.label.update({
                    where: { id: labelRecord.id },
                    data: { pdfPath: upload.path, status: 'COMPLETED' },
                  });
                  slog.info('order-pdf', 'PDF uploaded successfully', { path: upload.path });
                  pdfUploaded = true;
                } else if (attempt === 2) {
                  slog.warn('order-pdf', `PDF upload failed after ${attempt} attempts: ${upload.error}`, { guia: result.guia });
                }
                try { fs.unlinkSync(labelLocalPath); } catch { /* best-effort */ }
              } else if (attempt === 2) {
                slog.warn('order-pdf', `Could not download PDF after ${attempt} attempts (no file at expected path)`, { guia: result.guia });
              }
            } catch (downloadErr) {
              if (attempt === 2) {
                slog.warn('order-pdf', `PDF download/upload failed after ${attempt} attempts: ${(downloadErr as Error).message}`, { guia: result.guia });
              }
            }
          }
        } else {
          slog.warn('order-pdf', 'Guia is pending — no real shipment to download. Will be flagged NEEDS_REVIEW below (no charge to tenant).', { guia: result.guia });
        }

        // e) Fulfill order in Shopify with DAC tracking + notify customer
        //    fulfillMode: "off" = skip, "on" = normal (open only), "always" = force (all statuses)
        //    Read fulfillMode via raw query to avoid stale Prisma client issues
        let fulfillMode = 'on';
        try {
          const raw = await db.$queryRaw<{fulfillMode: string}[]>`SELECT "fulfillMode" FROM "Tenant" WHERE id = ${tenantId}`;
          if (raw[0]?.fulfillMode) fulfillMode = raw[0].fulfillMode;
        } catch { /* fallback to 'on' */ }
        const shouldFulfill = fulfillMode !== 'off';
        const forceAll = fulfillMode === 'always';
        // Tracks whether Shopify fulfillment ended in a real failure (not "already
        // fulfilled" which is a benign skip). Used downstream to suppress the
        // misleading "Order processed successfully" log when fulfillment actually
        // failed — DAC has the guia and the customer has nothing in Shopify.
        let fulfillFailedFatally = false;
        if (!testMode && shouldFulfill && result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            slog.info('order-fulfill', `Marking order ${order.name} as Prepared in Shopify (mode: ${fulfillMode})...`, { trackingUrl: result.trackingUrl ?? 'fallback' });
            await fulfillOrderWithTracking(shopifyClient, order.id, result.guia, result.trackingUrl, forceAll);
            slog.success('order-fulfill', `Order ${order.name} fulfilled in Shopify — tracking sent to customer`, { guia: result.guia, trackingUrl: result.trackingUrl ?? 'fallback' });
          } catch (fulfillErr) {
            if (fulfillErr instanceof ShopifyAlreadyFulfilledError) {
              // Multi-tenant race or manual fulfillment — not an error. Tracking
              // already went out via whoever fulfilled first; we just shouldn't
              // double-fulfill. The DAC guia is still valid for our records.
              slog.info('order-fulfill', `Order ${order.name} already fulfilled in Shopify (status: ${fulfillErr.status}) — skipping`, { guia: result.guia });
            } else if (fulfillErr instanceof ShopifyMissingScopesError) {
              // Configuration problem on the Shopify Custom App — not transient.
              // The error message itself contains the action items the operator
              // needs to take. Always ERROR level (regardless of forceAll).
              slog.error('order-fulfill', `Shopify CONFIG ERROR: ${fulfillErr.message}`, { guia: result.guia });
              fulfillFailedFatally = true;
            } else if (forceAll) {
              slog.error('order-fulfill', `Shopify fulfillment FAILED (force mode): ${(fulfillErr as Error).message}`, { guia: result.guia });
              fulfillFailedFatally = true;
            } else {
              slog.warn('order-fulfill', `Shopify fulfillment failed (non-fatal): ${(fulfillErr as Error).message}`, { guia: result.guia });
              fulfillFailedFatally = true;
            }
          }
        } else if (testMode) {
          slog.info('order-fulfill', `TEST MODE: Skipping Shopify fulfillment for ${order.name}`);
        } else if (!shouldFulfill) {
          slog.info('order-fulfill', `Fulfill DISABLED: Order ${order.name} NOT marked as Prepared (guia: ${result.guia})`);
        }

        // f) Mark order as processed in Shopify — tag + note (skip in testMode, skip if PENDING guia)
        if (!testMode && result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            await markOrderProcessed(shopifyClient, order.id, result.guia);
            slog.info('order-shopify', `Order ${order.name} tagged in Shopify`);
          } catch (tagErr) {
            slog.warn('order-shopify', `Shopify tagging failed (non-fatal): ${(tagErr as Error).message}`);
          }
        } else if (result.guia?.startsWith('PENDING-')) {
          slog.warn('order-shopify', `PENDING guia — NOT tagging ${order.name} in Shopify to avoid marking incomplete orders`);
        } else if (testMode) {
          slog.info('order-shopify', `TEST MODE: Skipping Shopify tag for ${order.name}`);
        }

        // f) Send email notification
        let emailSent = false;
        if (tenant.emailHost && tenant.emailUser) {
          const emailPass = decryptIfPresent(tenant.emailPass);
          if (emailPass) {
            emailSent = await sendShipmentNotification(
              order, result.guia, paymentType,
              tenant.storeName ?? tenant.name,
              {
                host: tenant.emailHost,
                port: tenant.emailPort ?? 587,
                user: tenant.emailUser,
                pass: emailPass,
                from: tenant.emailFrom ?? tenant.emailUser,
              }
            );
            if (emailSent) {
              await db.label.update({
                where: { id: labelRecord.id },
                data: { emailSent: true, emailSentAt: new Date() },
              });
              slog.info('order-email', `Notification email sent for ${order.name}`);
            }
          }
        }

        if (fulfillFailedFatally) {
          // DAC succeeded (label in DB, PDF saved, customer email sent if SMTP
          // configured) but Shopify never marked the order Prepared. Don't
          // claim success — the operator needs to know they have to mark it
          // manually OR fix the underlying config (typically missing scopes).
          slog.warn('order-complete', `Order ${order.name} partially processed: DAC OK but Shopify fulfillment failed — see prior order-fulfill log`, {
            guia: result.guia, paymentType, emailSent,
          });
        } else {
          slog.success('order-complete', `Order ${order.name} processed successfully`, {
            guia: result.guia, paymentType, emailSent,
          });
        }

        // ─ Billing fairness guard (2026-04-29) ──────────────────────────────
        // Only count toward the tenant's billed shipments when the customer
        // has a fully usable result. Two cases where they don't, despite the
        // worker reaching this branch without throwing:
        //
        //   (a) guia is "PENDING-*" — DAC didn't return a real number after
        //       retries. No PDF could be downloaded, no Shopify fulfillment
        //       happened (the `!startsWith('PENDING-')` guards above skipped
        //       both), no tracking email went out. The customer has nothing.
        //
        //   (b) PDF upload to S3 failed permanently after retries. DAC has the
        //       guia and Shopify is fulfilled, BUT the operator can't print
        //       the label from LabelFlow. From the operator's perspective the
        //       order is incomplete and needs hand-off.
        //
        // In both cases mark NEEDS_REVIEW so it surfaces in the dashboard and
        // do NOT increment successCount — that single counter is what
        // deductCreditsAndStamp uses to bill the tenant at job's end.
        const guiaIsPlaceholder = !!result.guia?.startsWith('PENDING-');
        if (guiaIsPlaceholder || !pdfUploaded) {
          const reason = guiaIsPlaceholder
            ? 'No se pudo extraer el número de guía DAC tras varios reintentos. Buscar manualmente en DAC historial.'
            : 'La guía DAC se generó pero el PDF no se pudo subir al storage. Re-subir manualmente desde el dashboard.';
          await db.label.update({
            where: { id: labelRecord.id },
            data: { status: 'NEEDS_REVIEW', errorMessage: reason },
          });
          failedCount++;
          slog.warn(
            'order-incomplete',
            `Order ${order.name}: marked NEEDS_REVIEW (no charge) — ${guiaIsPlaceholder ? 'guia is PENDING placeholder' : 'PDF upload failed'}`,
            { orderName: order.name, guia: result.guia, pdfUploaded },
          );
          // AI resolver feedback for the (b) case — guia exists, address
          // resolution itself was fine; mark accepted so cache reinforces.
          if (!guiaIsPlaceholder && result.aiResolutionHash) {
            await markAddressResolutionFeedback(
              tenantId,
              result.aiResolutionHash,
              true,
              result.guia,
            );
          }
        } else {
          // Full success path — AI feedback + bill the tenant.
          if (result.aiResolutionHash) {
            await markAddressResolutionFeedback(
              tenantId,
              result.aiResolutionHash,
              true,
              result.guia,
            );
          }
          successCount++;
          // Checkpoint to DB (2026-04-29). Persist progress every full
          // success so a hard crash (kill -9, OOM-killer, infra restart) is
          // not a silent revenue leak — the reconcile cron reads Job.successCount
          // when it auto-FAILs a stale RUNNING job, then drains credits for
          // the banked total. Failure of the checkpoint itself is logged but
          // non-fatal: the in-memory counter is still authoritative for the
          // happy path's end-of-job deductCreditsAndStamp call.
          await db.job
            .update({
              where: { id: jobId },
              data: { successCount: { increment: 1 } },
            })
            .catch((cpErr) => {
              logger.warn(
                { tenantId, jobId, error: (cpErr as Error).message },
                '[checkpoint] Failed to persist successCount mid-run (non-fatal)',
              );
            });
        }
      } catch (err) {
        // If DAC created a shipment but we failed downstream, track the guia so it
        // isn't reused for the next order in this batch (orphan guia protection)
        if (result?.guia && !result.guia.startsWith('PENDING-')) {
          usedGuias.add(result.guia);
        }

        const errorMsg = (err as Error).message;

        // AI resolver feedback: if this order used AI and failed, mark the
        // resolution as rejected so future calls re-resolve instead of cache-hitting.
        if (result?.aiResolutionHash) {
          await markAddressResolutionFeedback(
            tenantId,
            result.aiResolutionHash,
            false,
            undefined,
            errorMsg.slice(0, 500),
          );
        }

        const isDacGuiaConstraint = errorMsg.includes('Unique constraint') && errorMsg.includes('dacGuia');
        // C-4: distinguish a duplicate-submit guard trip from a real failure.
        // When createShipment refuses to re-enter the form because a
        // PendingShipment row already exists, we want the Label parked as
        // NEEDS_REVIEW (not FAILED) so the operator treats it as "look this
        // up in DAC historial" rather than "retry from scratch".
        const isDuplicateSubmit = err instanceof DuplicateSubmitError;
        // 2026-04-22 post-run audit: DAC silently rejects the form when the
        // customer's Shopify address doesn't resolve to a valid department/
        // barrio (e.g. city="Parquizado", address1="17 metros568"). Surface
        // this as NEEDS_REVIEW with a Spanish operator-friendly Shopify note
        // so the operator contacts the customer instead of retrying.
        const isDacAddressRejected = err instanceof DacAddressRejectedError;

        if (isDacGuiaConstraint) {
          slog.warn('order-fail', `Order ${order.name}: guia already assigned to another order, skipping`, {
            orderId: order.id,
            orderName: order.name,
            error: errorMsg.substring(0, 200),
          });
        } else if (isDuplicateSubmit) {
          slog.warn('order-fail', `Order ${order.name}: duplicate submit blocked (C-4) — needs operator review`, {
            orderId: order.id,
            orderName: order.name,
            priorStatus: (err as DuplicateSubmitError).existingStatus,
            priorGuia: (err as DuplicateSubmitError).existingGuia,
          });
        } else if (isDacAddressRejected) {
          // Audit 2026-05-06: distinguish "rescue failed (possible orphan guía in DAC)"
          // from "genuine rejection (no guía exists)". The first case is more dangerous
          // — we must NOT auto-retry or we pile up orphan guías DAC charges us for.
          const rescueFailed = (err as DacAddressRejectedError).rescueFailed;
          slog.warn(
            'order-fail',
            rescueFailed
              ? `Order ${order.name}: DAC silent reject + rescue exhausted — possible ORPHAN GUÍA in DAC; manual operator verification required (PendingShipment preserved to block auto-retry)`
              : `Order ${order.name}: DAC rejected form — address confusa, needs operator to contact customer`,
            {
              orderId: order.id,
              orderName: order.name,
              recipientName: customerName,
              shopifyCity: addr.city,
              shopifyAddress1: addr.address1,
              shopifyAddress2: addr.address2,
              shopifyZip: addr.zip,
              rescueFailed,
            },
          );
        } else {
          slog.error('order-fail', `Order ${order.name} failed: ${errorMsg}`);
        }

        // BUG FIX 5: Upsert instead of create to handle retries
        const dacRescueFailed =
          isDacAddressRejected && (err as DacAddressRejectedError).rescueFailed;
        const labelErrorMsg = isDacGuiaConstraint
          ? 'Guia already assigned to another order'
          : isDuplicateSubmit
            ? `C-4: prior submit exists (status=${(err as DuplicateSubmitError).existingStatus}, guia=${(err as DuplicateSubmitError).existingGuia ?? 'n/a'}); check DAC historial`
            : dacRescueFailed
              ? `Posible guía huérfana en DAC para ${customerName}. Verificar manualmente en historial DAC y vincular o desbloquear (PendingShipment preservado para evitar duplicados).`
              : isDacAddressRejected
                ? 'Dirección del cliente en Shopify no se pudo interpretar — contactar al cliente para corregirla y reprocesar.'
                : errorMsg.substring(0, 500);
        const labelTargetStatus: 'FAILED' | 'NEEDS_REVIEW' =
          isDuplicateSubmit || isDacAddressRejected ? 'NEEDS_REVIEW' : 'FAILED';

        const { fullAddress: mergedAddrErr } = mergeAddress(addr.address1, addr.address2);
        // Same null-safety as the success path — Label.city/department are required (non-null)
        const resolvedDeptRawErr = await getDepartmentForCityAsync(addr.city);
        const { safeCity: safeCityErr, safeDepartment: resolvedDeptErr } = buildSafeLabelGeoFields({
          city: addr.city,
          province: addr.province,
          resolvedDepartment: resolvedDeptRawErr,
        });
        // BLANK-PHONE FIX (audit 2026-06-02): the failure-path upsert used to
        // omit customerPhone entirely, so every DAC-rejected / NEEDS_REVIEW
        // order showed "sin número de teléfono" in the dashboard even when the
        // buyer DID leave a number. That defeats the whole "que el cadete se
        // comunique con el cliente" directive — the operator/courier needs that
        // number precisely for the hard addresses that land here. Resolve it the
        // same way the success path does (walks shipping→billing→customer→order→
        // saved). Coerce '' to undefined so a Prisma UPDATE never clobbers an
        // already-stored number with a blank.
        const failCustomerPhone = resolveOrderPhone(order) ?? (addr.phone || undefined);
        await db.label.upsert({
          where: {
            tenantId_shopifyOrderId: { tenantId, shopifyOrderId: String(order.id) },
          },
          create: {
            tenantId, jobId,
            shopifyOrderId: String(order.id),
            shopifyOrderName: order.name,
            customerName,
            customerEmail: order.email,
            customerPhone: failCustomerPhone,
            deliveryAddress: mergedAddrErr,
            city: safeCityErr,
            department: resolvedDeptErr,
            totalUyu: parseFloat(order.total_price) || 0,
            paymentType: 'DESTINATARIO',
            status: labelTargetStatus,
            errorMessage: labelErrorMsg,
          },
          update: {
            jobId,
            customerPhone: failCustomerPhone,
            status: labelTargetStatus,
            errorMessage: labelErrorMsg,
          },
        }).catch(() => {});

        // Only write error notes to Shopify for non-constraint errors,
        // and check for duplicate notes to avoid spamming.
        //
        // 2026-04-22 post-run audit: for DacAddressRejectedError (Shopify
        // address the customer typed can't be resolved to a DAC department/
        // barrio), emit a Spanish operator-friendly note instead of the raw
        // English error dump. Clearer for whoever is triaging Shopify and
        // dedupes correctly against itself on repeated reprocess attempts.
        if (!isDacGuiaConstraint) {
          // For DacAddressRejectedError, include ZIP (the operator often
          // needs it to spot a typo the resolver couldn't) AND, when we
          // successfully scraped DAC's own error box, the actual DAC
          // validation text — so the operator sees "ZIP inválido" /
          // "barrio obligatorio" instead of our catch-all "dirección
          // confusa". See scrapeDacErrorBox in dac/shipment.ts.
          const dacErrText = isDacAddressRejected
            ? (err as DacAddressRejectedError).dacErrorText
            : '';
          // Audit 2026-05-06: distinguish three cases for the operator:
          //   (a) genuine rejection w/ DAC error box → contact customer
          //   (b) genuine rejection w/o DAC error box → contact customer
          //   (c) silent reject + rescue exhausted → POSSIBLE ORPHAN GUÍA
          //       in DAC. Operator must verify historial first; the worker
          //       will NOT auto-retry (PendingShipment is preserved) to
          //       avoid creating duplicate guías DAC charges for.
          // Audit 2026-05-06 — surface the AI feasibility verdict in
          // the operator note. The AI's reasoning + operatorQuestion
          // (when shippable=false) gives the operator a concrete next
          // step instead of a generic "contact customer". For
          // rescue-failed cases the AI also tells the operator
          // whether the address looks like a real problem or just a
          // DAC platform hiccup — useful when deciding whether to
          // retry or escalate.
          const noteText = isDacAddressRejected
            ? dacRescueFailed
              ? `LabelFlow: DAC NO confirmó si se creó la guía para ${customerName} — ` +
                `URL quedó en /envios/nuevo, error box vacío, y el rescue del historial no encontró la guía después de 3 intentos. ` +
                `Es POSIBLE que DAC haya creado una guía huérfana para este cliente.\n\n` +
                (dacErrText ? `${dacErrText}\n\n` : '') +
                `ACCIÓN del operador (en este orden):\n` +
                `1. Entrar a DAC → Historial → buscar última guía a nombre de "${customerName}".\n` +
                `2. Si la guía EXISTE: copiar el número y vincularla manualmente en LabelFlow (admin → vincular guía).\n` +
                `3. Si la guía NO EXISTE: revisar la dirección con el cliente (ciudad="${addr.city ?? ''}", ` +
                `dirección="${addr.address1 ?? ''}"${addr.zip ? `, código postal="${addr.zip}"` : ''}), corregirla en Shopify, ` +
                `y desbloquear esta orden (admin → eliminar PendingShipment) para reintento.\n\n` +
                `IMPORTANTE: el worker NO va a reintentar automáticamente para evitar crear guías duplicadas.`
              : `LabelFlow: no se pudo crear el envío en DAC — dirección incompleta o confusa en Shopify ` +
                `(ciudad="${addr.city ?? ''}", dirección="${addr.address1 ?? ''}"${addr.address2 ? `, referencia="${addr.address2}"` : ''}` +
                `${addr.zip ? `, código postal="${addr.zip}"` : ''}). ` +
                (dacErrText
                  ? `${dacErrText} `
                  : `DAC rechazó el formulario porque la localidad/barrio no pudo identificarse. `) +
                `Acción: contactar al cliente para corregir la dirección en Shopify y el worker la va a reprocesar solo en el próximo ciclo.`
            : `LabelFlow ERROR: ${errorMsg.substring(0, 200)}`;
          try {
            const { data } = await shopifyClient.get(`/orders/${order.id}.json`);
            const currentNote: string = data.order?.note ?? '';
            // Prevent writing the same error note multiple times
            if (!currentNote.includes(noteText.substring(0, 80))) {
              await addOrderNote(shopifyClient, order.id, noteText);
            }
          } catch {
            // Silently ignore note-writing failures
          }
        }

        failedCount++;
      }

      // Rate limit between orders
      if (i < orders.length - 1) {
        await sleep(DELAY_BETWEEN_ORDERS_MS);
      }
    }

    // STEP 5: Save cookies for next run, then close browser
    await dacBrowser.saveCookies(tenantId);
    await dacBrowser.close();

    // STEP 6: Update job and tenant
    const durationMs = Date.now() - startTime;
    const status = failedCount === 0 ? 'COMPLETED' : (successCount > 0 ? 'PARTIAL' : 'FAILED');

    await db.job.update({
      where: { id: jobId },
      data: {
        status,
        totalOrders,
        successCount,
        failedCount,
        skippedCount,
        durationMs,
        finishedAt: new Date(),
      },
    });

    // Decrement de créditos por cada Finalizar exitoso. labelsTotal +
    // labelsThisMonth se mantienen como contadores de audit (no enforcement)
    // — útiles para gráficos históricos y para el admin dashboard. El gate
    // real es shipmentCredits + referralBonusCredits.
    //
    // El helper drena referralBonusCredits PRIMERO (envíos free de referido),
    // y sólo cuando se agota toca shipmentCredits (saldo pago). Si el tenant
    // tiene 5 bonus + 20 paid y procesa 3 envíos exitosos → bonus baja a 2,
    // paid intacto. Si procesa 8 → bonus a 0, paid baja a 17.
    await deductCreditsAndStamp(tenantId, successCount);

    slog.success('complete', `Cycle complete: ${successCount} success, ${failedCount} failed, ${skippedCount} skipped`, {
      durationMs, successCount, failedCount, skippedCount,
    });

  } catch (err) {
    await dacBrowser.close();
    const errorMsg = (err as Error).message;

    // ─ Billing fairness on crash (2026-04-29) ────────────────────────────
    // If the loop made it through some orders successfully BEFORE the fatal
    // error, those orders are already complete from the customer's view
    // (DAC guia exists, Shopify fulfilled, tracking emailed, PDF uploaded —
    // each of those gates incremented successCount only when ALL of them
    // succeeded). The deductCreditsAndStamp call lives at the end of the try
    // block, so without this drain the tenant is billed zero for a partially
    // successful crash run — silent revenue leak. Idempotent: 0 is a no-op.
    if (successCount > 0) {
      await deductCreditsAndStamp(tenantId, successCount).catch((deductErr) => {
        logger.error(
          { tenantId, jobId, successCount, error: (deductErr as Error).message },
          '[credits] Failed to drain credits in crash path — manual reconciliation needed',
        );
      });
    }

    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        totalOrders,
        successCount,
        failedCount,
        skippedCount,
        durationMs: Date.now() - startTime,
        finishedAt: new Date(),
        errorMessage: errorMsg,
      },
    });
    slog.error('fatal', `Fatal error: ${errorMsg}`);
  }
}
