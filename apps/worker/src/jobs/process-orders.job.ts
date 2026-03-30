import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { getConfig } from '../config';
import { createShopifyClient } from '../shopify/client';
import { getUnfulfilledOrders, markOrderProcessed, addOrderNote } from '../shopify/orders';
import { fulfillOrderWithTracking } from '../shopify/fulfillment';
import { dacBrowser } from '../dac/browser';
import { smartLogin } from '../dac/auth';
import { createShipment } from '../dac/shipment';
import { downloadLabel } from '../dac/label';
import { determinePaymentType } from '../rules/payment';
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
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
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

    // STEP 2: Get Shopify orders
    const shopifyClient = createShopifyClient(shopifyUrl, shopifyToken);
    let orders = await getUnfulfilledOrders(shopifyClient);

    slog.info('shopify', `Fetched ${orders.length} unfulfilled orders from Shopify`);

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

      try {
        // a) Determine payment type
        const paymentType = determinePaymentType(order, tenant.paymentThreshold);
        slog.info('order-payment', `Payment type: ${paymentType}`, { orderName: order.name });

        // b) Create shipment in DAC (with retry)
        const result = await withRetry(
          () => createShipment(page, order, paymentType, dacUsername, dacPassword, tenantId, jobId),
          MAX_RETRIES_PER_ORDER,
          `DAC shipment for ${order.name}`,
          slog
        );

        slog.success('order-shipment', `DAC shipment created for ${order.name}`, { guia: result.guia });

        // c) Create or update label record in DB (upsert to handle retries of FAILED labels)
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
            deliveryAddress: addr.address1,
            city: addr.city,
            department: addr.province,
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
          slog.warn('order-pdf', 'Guia is pending, skipping PDF download', { guia: result.guia });
          await db.label.update({
            where: { id: labelRecord.id },
            data: { status: 'COMPLETED' },
          });
        }

        // e) Fulfill order in Shopify with DAC tracking + notify customer
        if (!testMode && result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            slog.info('order-fulfill', `Marking order ${order.name} as Prepared in Shopify with tracking...`);
            await fulfillOrderWithTracking(shopifyClient, order.id, result.guia);
            slog.success('order-fulfill', `Order ${order.name} fulfilled in Shopify — tracking sent to customer`, { guia: result.guia });
          } catch (fulfillErr) {
            slog.warn('order-fulfill', `Shopify fulfillment failed (non-fatal): ${(fulfillErr as Error).message}`, { guia: result.guia });
          }
        } else if (testMode) {
          slog.info('order-fulfill', `TEST MODE: Skipping Shopify fulfillment for ${order.name}`);
        }

        // f) Mark order as processed in Shopify — tag + note (skip in testMode)
        if (!testMode) {
          try {
            await markOrderProcessed(shopifyClient, order.id, result.guia);
            slog.info('order-shopify', `Order ${order.name} tagged in Shopify`);
          } catch (tagErr) {
            slog.warn('order-shopify', `Shopify tagging failed (non-fatal): ${(tagErr as Error).message}`);
          }
        } else {
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
        successCount++;
      } catch (err) {
        const errorMsg = (err as Error).message;

        // BUG FIX 5: Upsert instead of create to handle retries
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
            deliveryAddress: addr.address1,
            city: addr.city,
            department: addr.province,
            totalUyu: parseFloat(order.total_price) || 0,
            paymentType: 'DESTINATARIO',
            status: 'FAILED',
            errorMessage: errorMsg.substring(0, 500),
          },
          update: {
            jobId,
            status: 'FAILED',
            errorMessage: errorMsg.substring(0, 500),
          },
        }).catch(() => {});

        await addOrderNote(shopifyClient, order.id, `LabelFlow ERROR: ${errorMsg.substring(0, 200)}`).catch(() => {});
        slog.error('order-fail', `Order ${order.name} failed: ${errorMsg}`);
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
