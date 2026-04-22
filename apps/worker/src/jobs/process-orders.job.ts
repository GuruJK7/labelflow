import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { getConfig } from '../config';
import { createShopifyClient } from '../shopify/client';
import { getUnfulfilledOrders, markOrderProcessed, addOrderNote } from '../shopify/orders';
import { fulfillOrderWithTracking } from '../shopify/fulfillment';
import { dacBrowser } from '../dac/browser';
import { smartLogin } from '../dac/auth';
import { createShipment, mergeAddress, DuplicateSubmitError, DacAddressRejectedError } from '../dac/shipment';
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
import { evaluateShippingRules, type ShippingRuleRow } from '../rules/shipping';
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

    // Check for maxOrders override in RunLog meta
    const overrideLog = await db.runLog.findFirst({
      where: { jobId, message: { contains: 'maxOrdersOverride' } },
      orderBy: { createdAt: 'desc' },
    });
    const maxOrdersOverride = (overrideLog?.meta as any)?.maxOrdersPerRun ?? 0;
    const testMode = !!(overrideLog?.meta as any)?.testMode;
    if (maxOrdersOverride > 0) {
      slog.info('config', `Max orders override: ${maxOrdersOverride}`);
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
    const dacUsername = tenant.dacUsername;
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

    // ── 2026-04-22 post-run audit ─────────────────────────────────────────
    // Shopify's `fulfillment_status=unfulfilled` is the single source of
    // truth. An order returned here is one the operator expects us to ship.
    //
    // We NO LONGER skip orders whose DB Label is COMPLETED. If the operator
    // manually cancelled a bad DAC shipment and unfulfilled the order in
    // Shopify, we must redo it — not silently skip because "the DB thinks
    // it's done". The Label.upsert a few lines below overwrites the old
    // guía/status on successful reprocess, and the Shopify note append
    // preserves the prior guía for audit.
    //
    // Safety: every active tenant has fulfillMode = "on" | "always", so a
    // successful reprocess re-fulfills the order in Shopify and it leaves
    // the unfulfilled set. The only way an order stays in this list after
    // we touch it is if Shopify fulfillment POST fails OR the tenant has
    // fulfillMode="off" (no active tenant currently does). Both cases are
    // already handled by the existing retry/PENDING-guía flow.
    //
    // We still look up existing labels to emit a telemetry line when we're
    // about to reprocess something that previously COMPLETED — easy to grep
    // if duplicate-DAC-shipment reports ever come in.
    const existingCompletedLabels = await db.label.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
        NOT: { dacGuia: { startsWith: 'PENDING-' } },
      },
      select: { shopifyOrderId: true, dacGuia: true, updatedAt: true },
    });
    const completedByOrderId = new Map(
      existingCompletedLabels.map((l) => [l.shopifyOrderId, l] as const),
    );
    const reprocessCount = orders.filter((o) => completedByOrderId.has(String(o.id))).length;
    if (reprocessCount > 0) {
      const reprocessDetails = orders
        .filter((o) => completedByOrderId.has(String(o.id)))
        .slice(0, 10)
        .map((o) => {
          const prev = completedByOrderId.get(String(o.id))!;
          return { orderName: o.name, previousGuia: prev.dacGuia, previousCompletedAt: prev.updatedAt };
        });
      slog.warn(
        'filter',
        `Reprocessing ${reprocessCount} order(s) that were previously COMPLETED — operator unfulfilled them in Shopify`,
        { reprocessDetails },
      );
    }

    // Product type filter: only process orders containing allowed product types
    // Read fresh from DB to avoid stale Prisma client cache
    let allowedProductTypes: string[] | null = tenant.allowedProductTypes as string[] | null;
    let productTypeCache: Record<string, string> | null = tenant.productTypeCache as Record<string, string> | null;
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

    if (allowedProductTypes && allowedProductTypes.length > 0 && !productTypeCache) {
      slog.warn('filter', `Product type filter configured (${allowedProductTypes.join(', ')}) but no product cache — run "Escanear Shopify" first. Processing ALL orders.`);
    }
    if (allowedProductTypes && allowedProductTypes.length > 0 && productTypeCache) {
      const beforeProductFilter = orders.length;
      const allowedSet = new Set(allowedProductTypes.map(t => t.toLowerCase()));
      orders = orders.filter(order => {
        return order.line_items.some(item => {
          if (!item.product_id) return false;
          const pType = productTypeCache[String(item.product_id)];
          if (!pType) return false;
          return allowedSet.has(pType.toLowerCase());
        });
      });
      const productFiltered = beforeProductFilter - orders.length;
      if (productFiltered > 0) {
        slog.info('filter', `Product type filter: excluded ${productFiltered} orders (allowed: ${allowedProductTypes.join(', ')})`);
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

    // Apply limit (override from UI takes priority over tenant default)
    const effectiveLimit = maxOrdersOverride > 0 ? maxOrdersOverride : tenant.maxOrdersPerRun;
    if (orders.length > effectiveLimit) {
      skippedCount = orders.length - effectiveLimit;
      orders = orders.slice(0, effectiveLimit);
      slog.warn('limit', `Limited to ${effectiveLimit} orders, ${skippedCount} skipped`);
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

    // STEP 4: Process each order sequentially with retry
    const config = getConfig();
    const tmpDir = path.join(config.LABELS_TMP_DIR, new Date().toISOString().split('T')[0]);

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
              customerPhone: addr.phone,
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
            customerPhone: addr.phone,
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

        // d) Download PDF label (skip if guia is temporary/pending)
        if (result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            slog.info('order-pdf', `Downloading PDF for guia ${result.guia}`);
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
              }
              fs.unlinkSync(labelLocalPath);
            }
          } catch (downloadErr) {
            slog.warn('order-pdf', `PDF download failed (non-fatal): ${(downloadErr as Error).message}`, { guia: result.guia });
          }
        } else {
          slog.warn('order-pdf', 'Guia is pending, skipping PDF download — label stays as CREATED (not COMPLETED)', { guia: result.guia });
          // DO NOT mark as COMPLETED — a PENDING guia is not a finished job.
          // Keeping status as CREATED allows future reconciliation or manual review.
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
        if (!testMode && shouldFulfill && result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            slog.info('order-fulfill', `Marking order ${order.name} as Prepared in Shopify (mode: ${fulfillMode})...`, { trackingUrl: result.trackingUrl ?? 'fallback' });
            await fulfillOrderWithTracking(shopifyClient, order.id, result.guia, result.trackingUrl, forceAll);
            slog.success('order-fulfill', `Order ${order.name} fulfilled in Shopify — tracking sent to customer`, { guia: result.guia, trackingUrl: result.trackingUrl ?? 'fallback' });
          } catch (fulfillErr) {
            if (forceAll) {
              slog.error('order-fulfill', `Shopify fulfillment FAILED (force mode): ${(fulfillErr as Error).message}`, { guia: result.guia });
            } else {
              slog.warn('order-fulfill', `Shopify fulfillment failed (non-fatal): ${(fulfillErr as Error).message}`, { guia: result.guia });
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

        slog.success('order-complete', `Order ${order.name} processed successfully`, {
          guia: result.guia, paymentType, emailSent,
        });

        // AI resolver feedback: if this order used AI to resolve its address,
        // mark the resolution as accepted so it gets reinforced in the cache.
        if (result.aiResolutionHash) {
          await markAddressResolutionFeedback(
            tenantId,
            result.aiResolutionHash,
            true,
            result.guia,
          );
        }

        successCount++;
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
          slog.warn('order-fail', `Order ${order.name}: DAC rejected form — address confusa, needs operator to contact customer`, {
            orderId: order.id,
            orderName: order.name,
            shopifyCity: addr.city,
            shopifyAddress1: addr.address1,
            shopifyAddress2: addr.address2,
            shopifyZip: addr.zip,
          });
        } else {
          slog.error('order-fail', `Order ${order.name} failed: ${errorMsg}`);
        }

        // BUG FIX 5: Upsert instead of create to handle retries
        const labelErrorMsg = isDacGuiaConstraint
          ? 'Guia already assigned to another order'
          : isDuplicateSubmit
            ? `C-4: prior submit exists (status=${(err as DuplicateSubmitError).existingStatus}, guia=${(err as DuplicateSubmitError).existingGuia ?? 'n/a'}); check DAC historial`
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
          const noteText = isDacAddressRejected
            ? `LabelFlow: no se pudo crear el envío en DAC — dirección confusa o incompleta en Shopify ` +
              `(ciudad="${addr.city ?? ''}", dirección="${addr.address1 ?? ''}"${addr.address2 ? `, referencia="${addr.address2}"` : ''}` +
              `${addr.zip ? `, código postal="${addr.zip}"` : ''}). ` +
              (dacErrText
                ? `DAC mostró este mensaje de validación: "${dacErrText}". `
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

    await db.tenant.update({
      where: { id: tenantId },
      data: {
        labelsThisMonth: { increment: successCount },
        labelsTotal: { increment: successCount },
        lastRunAt: new Date(),
      },
    });

    slog.success('complete', `Cycle complete: ${successCount} success, ${failedCount} failed, ${skippedCount} skipped`, {
      durationMs, successCount, failedCount, skippedCount,
    });

  } catch (err) {
    await dacBrowser.close();
    const errorMsg = (err as Error).message;
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
