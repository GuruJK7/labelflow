import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { getConfig } from '../config';
import { createShopifyClient } from '../shopify/client';
import { getUnfulfilledOrders, markOrderProcessed, addOrderNote } from '../shopify/orders';
import { dacBrowser } from '../dac/browser';
import { smartLogin } from '../dac/auth';
import { createShipment } from '../dac/shipment';
import { downloadLabel } from '../dac/label';
import { determinePaymentType } from '../rules/payment';
import { sendShipmentNotification } from '../notifier/email';
import { uploadLabelPdf } from '../storage/upload';
import logger from '../logger';
import { sleep } from '../utils';
import fs from 'fs';
import path from 'path';

const DELAY_BETWEEN_ORDERS_MS = 500;

export async function processOrdersJob(tenantId: string, jobId: string): Promise<void> {
  const startTime = Date.now();
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let totalOrders = 0;

  const logToDB = async (level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', message: string, meta?: Record<string, unknown>) => {
    await db.runLog.create({
      data: { tenantId, jobId, level, message, meta: meta ? JSON.parse(JSON.stringify(meta)) : undefined },
    }).catch(() => {});
  };

  try {
    // Mark job as running
    await db.job.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // STEP 1: Load tenant config and decrypt credentials
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      await logToDB('ERROR', 'Tenant not found');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Tenant not found' } });
      return;
    }

    const shopifyUrl = tenant.shopifyStoreUrl;
    const shopifyToken = decryptIfPresent(tenant.shopifyToken);
    const dacUsername = tenant.dacUsername;
    const dacPassword = decryptIfPresent(tenant.dacPassword);

    if (!shopifyUrl || !shopifyToken) {
      await logToDB('ERROR', 'Shopify credentials not configured');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing Shopify config' } });
      return;
    }

    if (!dacUsername || !dacPassword) {
      await logToDB('ERROR', 'DAC credentials not configured');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing DAC config' } });
      return;
    }

    await logToDB('INFO', 'Starting order processing cycle');

    // STEP 2: Get Shopify orders
    const shopifyClient = createShopifyClient(shopifyUrl, shopifyToken);
    let orders = await getUnfulfilledOrders(shopifyClient);
    totalOrders = orders.length;

    if (orders.length === 0) {
      await logToDB('INFO', 'No pending orders found');
      await db.job.update({
        where: { id: jobId },
        data: { status: 'COMPLETED', totalOrders: 0, finishedAt: new Date(), durationMs: Date.now() - startTime },
      });
      return;
    }

    // Apply limit
    if (orders.length > tenant.maxOrdersPerRun) {
      skippedCount = orders.length - tenant.maxOrdersPerRun;
      orders = orders.slice(0, tenant.maxOrdersPerRun);
      await logToDB('WARN', `Limited to ${tenant.maxOrdersPerRun} orders, ${skippedCount} skipped`);
    }

    // STEP 3: Start browser and login to DAC
    const page = await dacBrowser.getPage();
    try {
      await smartLogin(page, dacUsername, dacPassword, tenantId);
      await logToDB('SUCCESS', 'DAC login successful');
    } catch (err) {
      await logToDB('ERROR', `DAC login failed: ${(err as Error).message}`);
      await dacBrowser.close();
      await db.job.update({
        where: { id: jobId },
        data: { status: 'FAILED', totalOrders, errorMessage: 'DAC login failed', finishedAt: new Date(), durationMs: Date.now() - startTime },
      });
      return;
    }

    // STEP 4: Process each order sequentially
    const config = getConfig();
    const tmpDir = path.join(config.LABELS_TMP_DIR, new Date().toISOString().split('T')[0]);

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const addr = order.shipping_address;
      const customerName = addr ? `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente' : 'Sin datos';

      // Validate address
      if (!addr || !addr.address1) {
        await db.label.create({
          data: {
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
        });
        await addOrderNote(shopifyClient, order.id, 'LabelFlow ERROR: No shipping address').catch(() => {});
        await logToDB('ERROR', `Order ${order.name} skipped: no shipping address`);
        failedCount++;
        continue;
      }

      try {
        // a) Determine payment type
        const paymentType = determinePaymentType(order, tenant.paymentThreshold);

        // b) Create shipment in DAC
        const result = await createShipment(page, order, paymentType, dacUsername, dacPassword, tenantId);

        // c) Create label record in DB
        const labelRecord = await db.label.create({
          data: {
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
        });

        // d) Download PDF label (skip if guia is temporary/pending)
        if (result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            const labelLocalPath = await downloadLabel(page, result.guia, tmpDir, dacUsername, dacPassword);
            if (labelLocalPath && fs.existsSync(labelLocalPath)) {
              const pdfBuffer = fs.readFileSync(labelLocalPath);
              const upload = await uploadLabelPdf(tenantId, labelRecord.id, pdfBuffer);
              if (!upload.error) {
                await db.label.update({
                  where: { id: labelRecord.id },
                  data: { pdfPath: upload.path, status: 'COMPLETED' },
                });
              }
              fs.unlinkSync(labelLocalPath);
            }
          } catch (downloadErr) {
            logger.warn({ guia: result.guia, error: (downloadErr as Error).message }, 'PDF download failed, shipment still created');
          }
        } else {
          logger.warn({ guia: result.guia }, 'Guia is pending, skipping PDF download');
          await db.label.update({
            where: { id: labelRecord.id },
            data: { status: 'COMPLETED' },  // Mark as completed even without PDF
          });
        }

        // e) Mark order as processed in Shopify
        await markOrderProcessed(shopifyClient, order.id, result.guia);

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
            }
          }
        }

        await logToDB('SUCCESS', `Order ${order.name} processed`, { guia: result.guia, paymentType, emailSent });
        successCount++;
      } catch (err) {
        const errorMsg = (err as Error).message;

        await db.label.create({
          data: {
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
        }).catch(() => {});

        await addOrderNote(shopifyClient, order.id, `LabelFlow ERROR: ${errorMsg.substring(0, 200)}`).catch(() => {});
        await logToDB('ERROR', `Order ${order.name} failed: ${errorMsg}`);
        failedCount++;
      }

      // Rate limit: 2s between orders
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

    await logToDB('INFO', `Cycle complete: ${successCount} success, ${failedCount} failed, ${skippedCount} skipped`, { durationMs });

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
    await logToDB('ERROR', `Fatal error: ${errorMsg}`);
  }
}
