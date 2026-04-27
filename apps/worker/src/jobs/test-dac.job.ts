import { db } from '../db';
import { decrypt, decryptIfPresent } from '../encryption';
import { createShopifyClient } from '../shopify/client';
import { getRecentOrders } from '../shopify/orders';
import { dacBrowser } from '../dac/browser';
import { smartLogin } from '../dac/auth';
import { createShipment, mergeAddress } from '../dac/shipment';
import { markAddressResolutionFeedback } from '../dac/ai-resolver';
import { buildSafeLabelGeoFields } from './label-safe-fields';
import { getDepartmentForCity } from '../dac/uruguay-geo';
import { downloadLabel } from '../dac/label';
import { determinePaymentType } from '../rules/payment';
import { uploadLabelPdf } from '../storage/upload';
import { createStepLogger } from '../logger';
import { sleep } from '../utils';
import { getConfig } from '../config';
import fs from 'fs';
import path from 'path';

const DELAY_BETWEEN_ORDERS_MS = 500;

/**
 * TEST DAC job processor.
 * - Fetches recent Shopify orders (regardless of fulfillment status)
 * - Processes them through DAC using provided test credentials
 * - Does NOT tag, fulfill, or modify anything in Shopify
 * - Does NOT send customer emails
 * - Saves labels with TEST prefix in shopifyOrderName for easy identification
 */
export async function testDacJob(tenantId: string, jobId: string): Promise<void> {
  const startTime = Date.now();
  let successCount = 0;
  let failedCount = 0;
  let totalOrders = 0;

  const slog = createStepLogger(jobId, tenantId);

  try {
    await db.job.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // Read test config from RunLog
    const configLog = await db.runLog.findFirst({
      where: { jobId, message: 'testDacConfig' },
      orderBy: { createdAt: 'desc' },
    });

    const meta = configLog?.meta as Record<string, unknown> | null;
    if (!meta?.testDac) {
      slog.error('config', 'No test DAC config found in RunLog');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing test config' } });
      return;
    }

    const dacUsername = meta.dacUsername as string;
    // Audit 2026-04-27 H-04: password is now persisted encrypted (AES-256-GCM)
    // by the web API. Decrypt here using the same ENCRYPTION_KEY both processes
    // share. Falls back to legacy `dacPassword` plaintext only for in-flight
    // jobs created before the fix landed (zero-downtime deploy bridge); remove
    // the fallback after one full deploy cycle.
    const dacPasswordEnc = meta.dacPasswordEnc as string | undefined;
    const dacPassword = dacPasswordEnc
      ? decrypt(dacPasswordEnc)
      : (meta.dacPassword as string | undefined) ?? '';
    const maxOrders = (meta.maxOrders as number) || 3;
    const specificOrderIds = meta.orderIds as string[] | null;

    if (!dacPassword) {
      slog.error('config', 'No DAC password in test config (encrypted blob missing or empty)');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing test password' } });
      return;
    }

    slog.info('config', `TEST DAC mode: user=${dacUsername}, maxOrders=${maxOrders}, specificIds=${specificOrderIds?.join(',') ?? 'none'}`);

    // Load tenant for Shopify credentials
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      slog.error('config', 'Tenant not found');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Tenant not found' } });
      return;
    }

    const shopifyUrl = tenant.shopifyStoreUrl;
    const shopifyToken = decryptIfPresent(tenant.shopifyToken);

    if (!shopifyUrl || !shopifyToken) {
      slog.error('config', 'Shopify credentials not configured');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing Shopify config' } });
      return;
    }

    // Fetch recent orders from Shopify.
    //
    // BUG FIX (2026-04-10): when specificOrderIds is provided, we MUST fetch enough
    // orders to actually find them. The previous implementation fetched only
    // `maxOrders` recent orders and then filtered, which silently dropped any target
    // order that wasn't in the most recent N. This made the orderIds feature
    // unusable for any historical replay (e.g. testing the 20 Curva Divina orders
    // from yesterday — most of which were not in the 20 most recent orders).
    //
    // The fix: when orderIds is provided, fetch up to 250 (Shopify's max per call)
    // recent orders, then filter. The maxOrders cap is also bypassed in this mode
    // so all matched IDs are processed, not just the first N.
    const shopifyClient = createShopifyClient(shopifyUrl, shopifyToken);
    const hasSpecificIds = !!(specificOrderIds && specificOrderIds.length > 0);
    const fetchLimit = hasSpecificIds ? 250 : maxOrders;
    let orders = await getRecentOrders(shopifyClient, fetchLimit);
    slog.info('shopify', `Fetched ${orders.length} recent orders from Shopify (fetchLimit=${fetchLimit})`);

    // Filter to specific order IDs if provided
    if (hasSpecificIds) {
      const targetSet = new Set(specificOrderIds);
      orders = orders.filter(o =>
        targetSet.has(String(o.id)) ||
        targetSet.has(o.name) ||
        targetSet.has(o.name?.replace(/^#/, '') ?? ''),
      );
      slog.info('filter', `Filtered to ${orders.length} specific orders (out of ${specificOrderIds.length} requested)`);
      if (orders.length < specificOrderIds.length) {
        const found = new Set(orders.map(o => String(o.id)));
        const missing = specificOrderIds.filter(id => !found.has(id));
        slog.warn('filter', `${missing.length} requested orderIds were NOT found in the last ${fetchLimit} Shopify orders`, { missing });
      }
    } else {
      // Only cap to maxOrders when not in specific-ID mode
      orders = orders.slice(0, maxOrders);
    }
    totalOrders = orders.length;

    if (orders.length === 0) {
      slog.info('complete', 'No orders to process');
      await db.job.update({
        where: { id: jobId },
        data: { status: 'COMPLETED', totalOrders: 0, finishedAt: new Date(), durationMs: Date.now() - startTime },
      });
      return;
    }

    // Log all orders that will be processed
    for (const o of orders) {
      const addr = o.shipping_address;
      slog.info('order-preview', `Will process: ${o.name} | ${addr?.address1 ?? 'NO ADDR'} ${addr?.address2 ?? ''} | ${addr?.city ?? ''} | $${o.total_price} ${o.currency}`);
    }

    // Start browser and login to DAC with TEST credentials
    slog.info('dac-login', `Starting browser and logging into DAC as ${dacUsername}`);
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

    const config = getConfig();
    const tmpDir = path.join(config.LABELS_TMP_DIR, 'test-dac', new Date().toISOString().split('T')[0]);

    // No guia protection needed for test — use empty set
    const usedGuias = new Set<string>();

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const addr = order.shipping_address;
      const customerName = addr ? `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente' : 'Sin datos';

      slog.info('order-start', `[TEST] Processing ${i + 1}/${orders.length}: ${order.name} | ${customerName}`, {
        orderId: order.id,
        orderName: order.name,
        address1: addr?.address1,
        address2: addr?.address2,
        city: addr?.city,
        province: addr?.province,
      });

      if (!addr || !addr.address1) {
        slog.error('order-validate', `[TEST] Order ${order.name} skipped: no shipping address`);
        failedCount++;
        continue;
      }

      // Hoisted so the catch block can access aiResolutionHash on failure
      let result: { guia: string; trackingUrl?: string; screenshotPath?: string; aiResolutionHash?: string } | undefined;

      try {
        const paymentType = determinePaymentType(order, tenant.paymentThreshold, tenant.paymentRuleEnabled);
        slog.info('order-payment', `[TEST] Payment: ${paymentType} (total: $${order.total_price} ${order.currency}, threshold: ${tenant.paymentThreshold})`);

        // Merge address and detect department
        // Use buildSafeLabelGeoFields to guarantee non-null values for the Prisma
        // required fields — see apps/worker/src/jobs/label-safe-fields.ts.
        const { fullAddress: mergedAddr, extraObs } = mergeAddress(addr.address1, addr.address2);
        const { safeCity, safeDepartment: resolvedDept } = buildSafeLabelGeoFields({
          city: addr.city,
          province: addr.province,
          resolvedDepartment: getDepartmentForCity(addr.city),
        });

        slog.info('order-address', `[TEST] Address: "${mergedAddr}" | Dept: ${resolvedDept} | City: ${addr.city} | Obs: "${extraObs}"`);

        // Create shipment in DAC
        result = await createShipment(page, order, paymentType, dacUsername, dacPassword, tenantId, jobId, usedGuias);

        // Treat PENDING guia as failure — it means DAC did not confirm shipment creation
        if (!result.guia || result.guia.startsWith('PENDING-')) {
          throw new Error(`DAC did not return a valid guia (got: ${result.guia ?? 'null'}) — shipment likely not created`);
        }

        usedGuias.add(result.guia);

        slog.success('order-shipment', `[TEST] DAC shipment created: guia=${result.guia}`, { trackingUrl: result.trackingUrl });

        // Check if guia already exists (from original processing) — use TEST- prefix to avoid unique constraint
        const testGuia = result.guia ? `TEST-${result.guia}` : null;

        // Save label with [TEST] prefix
        const labelRecord = await db.label.upsert({
          where: {
            tenantId_shopifyOrderId: { tenantId, shopifyOrderId: `TEST-${order.id}` },
          },
          create: {
            tenantId, jobId,
            shopifyOrderId: `TEST-${order.id}`,
            shopifyOrderName: `[TEST] ${order.name}`,
            customerName,
            customerEmail: order.email,
            customerPhone: addr.phone,
            deliveryAddress: mergedAddr,
            city: safeCity,
            department: resolvedDept,
            totalUyu: parseFloat(order.total_price) || 0,
            paymentType,
            dacGuia: testGuia,
            status: 'CREATED',
          },
          update: {
            jobId,
            dacGuia: testGuia,
            deliveryAddress: mergedAddr,
            department: resolvedDept,
            status: 'CREATED',
            errorMessage: null,
          },
        });

        // Download PDF
        if (result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            slog.info('order-pdf', `[TEST] Downloading PDF for guia ${result.guia}`);
            const labelLocalPath = await downloadLabel(page, result.guia, tmpDir, dacUsername, dacPassword);
            if (labelLocalPath && fs.existsSync(labelLocalPath)) {
              const pdfBuffer = fs.readFileSync(labelLocalPath);
              const upload = await uploadLabelPdf(tenantId, labelRecord.id, pdfBuffer);
              if (!upload.error) {
                await db.label.update({
                  where: { id: labelRecord.id },
                  data: { pdfPath: upload.path, status: 'COMPLETED' },
                });
                slog.info('order-pdf', '[TEST] PDF uploaded');
              }
              fs.unlinkSync(labelLocalPath);
            }
          } catch (downloadErr) {
            slog.warn('order-pdf', `[TEST] PDF download failed: ${(downloadErr as Error).message}`);
          }
        } else {
          await db.label.update({
            where: { id: labelRecord.id },
            data: { status: 'COMPLETED' },
          });
        }

        // NO Shopify fulfillment
        slog.info('order-shopify', `[TEST] Skipping Shopify fulfillment/tagging for ${order.name}`);

        // NO email
        slog.info('order-email', `[TEST] Skipping email notification for ${order.name}`);

        slog.success('order-complete', `[TEST] Order ${order.name} processed OK`, {
          guia: result.guia, paymentType, mergedAddr, department: resolvedDept,
        });

        // AI resolver feedback: mark resolution as accepted if AI was used
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
        slog.error('order-fail', `[TEST] Order ${order.name} failed: ${(err as Error).message}`);

        // AI resolver feedback: mark resolution as rejected if AI was used
        // result may be undefined if createShipment threw before returning — guard for it
        if (result?.aiResolutionHash) {
          await markAddressResolutionFeedback(
            tenantId,
            result.aiResolutionHash,
            false,
            undefined,
            (err as Error).message?.slice(0, 500),
          );
        }

        failedCount++;
      }

      if (i < orders.length - 1) {
        await sleep(DELAY_BETWEEN_ORDERS_MS);
      }
    }

    await dacBrowser.close();

    const durationMs = Date.now() - startTime;
    const status = failedCount === 0 ? 'COMPLETED' : (successCount > 0 ? 'PARTIAL' : 'FAILED');

    await db.job.update({
      where: { id: jobId },
      data: {
        status,
        totalOrders,
        successCount,
        failedCount,
        skippedCount: 0,
        durationMs,
        finishedAt: new Date(),
      },
    });

    slog.success('complete', `[TEST] Done: ${successCount} success, ${failedCount} failed in ${Math.round(durationMs / 1000)}s`);

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
        durationMs: Date.now() - startTime,
        finishedAt: new Date(),
        errorMessage: errorMsg,
      },
    });
    slog.error('fatal', `[TEST] Fatal error: ${errorMsg}`);
  }
}
