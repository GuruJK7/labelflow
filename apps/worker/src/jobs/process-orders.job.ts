import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { getConfig } from '../config';
import { createShopifyClient } from '../shopify/client';
import { getUnfulfilledOrders, markOrderProcessed, addOrderNote } from '../shopify/orders';
import { fulfillOrderWithTracking } from '../shopify/fulfillment';
import { dacBrowser } from '../dac/browser';
import { smartLogin } from '../dac/auth';
import { createShipment, mergeAddress } from '../dac/shipment';
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

export async function processOrdersJob(tenantId: string, jobId: string): Promise<void> {
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

    // BUG FIX 5: Filter out orders with existing CREATED/COMPLETED labels
    // BUT allow retry of FAILED labels (previously blocked by unique constraint)
    const existingLabels = await db.label.findMany({
      where: {
        tenantId,
        status: { in: ['CREATED', 'COMPLETED'] },
      },
      select: { shopifyOrderId: true },
    });
    const processedIds = new Set(existingLabels.map(l => l.shopifyOrderId));
    const beforeFilter = orders.length;
    orders = orders.filter(o => !processedIds.has(String(o.id)));
    const filteredOut = beforeFilter - orders.length;
    if (filteredOut > 0) {
      slog.info('filter', `Filtered out ${filteredOut} orders with existing CREATED/COMPLETED labels`);
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

      let result: { guia: string; trackingUrl?: string; screenshotPath?: string; aiResolutionHash?: string } | undefined;
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

        // b) Check if this order already has a REAL guia from a previous failed attempt
        //    This prevents creating DUPLICATE DAC shipments when the DB write failed before
        const existingLabel = await db.label.findUnique({
          where: { tenantId_shopifyOrderId: { tenantId, shopifyOrderId: String(order.id) } },
          select: { dacGuia: true, status: true },
        });

        if (existingLabel?.dacGuia && !existingLabel.dacGuia.startsWith('PENDING-') && existingLabel.status === 'FAILED') {
          // This order already has a real DAC guia from a previous run that failed downstream.
          // A human would NOT re-submit the DAC form — they would continue from where it failed.
          slog.warn('order-shipment', `Order ${order.name} already has guia ${existingLabel.dacGuia} from a failed run — skipping DAC form, reusing guia`);
          result = { guia: existingLabel.dacGuia };
          usedGuias.add(result.guia);
        } else {
          // Create shipment in DAC (NO full-form retry — guia extraction retries internally)
          // Re-submitting the entire form on error creates DUPLICATE shipments in DAC
          result = await createShipment(page, order, paymentType, dacUsername, dacPassword, tenantId, jobId, usedGuias);

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
            dacGuia: result.guia,
            status: 'CREATED',
          },
          update: {
            jobId,
            dacGuia: result.guia,
            status: 'CREATED',
            errorMessage: null,
          },
        });

        slog.info('order-db', `Label record saved: ${labelRecord.id}`, { guia: result.guia });

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

        if (isDacGuiaConstraint) {
          slog.warn('order-fail', `Order ${order.name}: guia already assigned to another order, skipping`, {
            orderId: order.id,
            orderName: order.name,
            error: errorMsg.substring(0, 200),
          });
        } else {
          slog.error('order-fail', `Order ${order.name} failed: ${errorMsg}`);
        }

        // BUG FIX 5: Upsert instead of create to handle retries
        const labelErrorMsg = isDacGuiaConstraint
          ? 'Guia already assigned to another order'
          : errorMsg.substring(0, 500);

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
            status: 'FAILED',
            errorMessage: labelErrorMsg,
          },
          update: {
            jobId,
            status: 'FAILED',
            errorMessage: labelErrorMsg,
          },
        }).catch(() => {});

        // Only write error notes to Shopify for non-constraint errors,
        // and check for duplicate notes to avoid spamming
        if (!isDacGuiaConstraint) {
          const noteText = `LabelFlow ERROR: ${errorMsg.substring(0, 200)}`;
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
