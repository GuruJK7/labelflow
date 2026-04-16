/**
 * Bulk order processing job — AGENT-BASED architecture.
 *
 * After hours of debugging, we confirmed Playwright on Render Docker cannot
 * upload files to DAC's /envios/masivos endpoint (setInputFiles does not
 * produce a valid upload from the server's POV). The workaround: run the
 * upload step on a real Mac with Chrome + Claude Agent (computer use), which
 * DAC accepts as a normal user.
 *
 * New flow (this file):
 *   1. Render worker picks up a PROCESS_ORDERS_BULK job (status=PENDING)
 *   2. Fetch Shopify orders (same as before)
 *   3. Generate the xlsx in-memory (same as before)
 *   4. Upload the xlsx to Supabase Storage: bulk-xlsx/{tenantId}/{jobId}.xlsx
 *   5. Mark the Job as WAITING_FOR_AGENT with xlsxStoragePath set
 *   6. Agent (Adrian's Mac) polls for WAITING_FOR_AGENT jobs, handles the DAC
 *      upload via Chrome MCP, extracts guias, creates Labels, marks COMPLETED
 *
 * Fallback rows (orders that can't go through DAC bulk — missing department,
 * retiro en agencia, etc.) are saved as FAILED labels here. The user can
 * retry them individually through the regular flow.
 */

import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { createShopifyClient } from '../shopify/client';
import { getUnfulfilledOrders } from '../shopify/orders';
import { generateBulkXlsx } from '../dac/bulk-xlsx';
import { uploadBulkXlsxToStorage } from '../storage/upload';
import { createStepLogger } from '../logger';
import { buildSafeLabelGeoFields } from './label-safe-fields';
import logger from '../logger';

export async function processOrdersBulkJob(tenantId: string, jobId: string): Promise<void> {
  const startTime = Date.now();
  let totalOrders = 0;
  let fallbackCount = 0;

  const slog = createStepLogger(jobId, tenantId);

  try {
    await db.job.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // Load tenant config
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      slog.error('config', 'Tenant not found');
      await db.job.update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: 'Tenant not found', finishedAt: new Date() },
      });
      return;
    }

    const shopifyUrl = tenant.shopifyStoreUrl;
    const shopifyToken = decryptIfPresent(tenant.shopifyToken);

    // DAC creds are checked by the agent, not here — we just need Shopify to generate the xlsx
    if (!shopifyUrl || !shopifyToken) {
      slog.error('config', 'Missing Shopify credentials');
      await db.job.update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: 'Missing Shopify credentials', finishedAt: new Date() },
      });
      return;
    }

    // Also verify DAC creds are configured (agent will use them)
    if (!tenant.dacUsername || !tenant.dacPassword) {
      slog.error('config', 'Missing DAC credentials — agent cannot process');
      await db.job.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: 'Missing DAC credentials for this tenant',
          finishedAt: new Date(),
        },
      });
      return;
    }

    // 1. Fetch Shopify orders
    slog.info('shopify', 'Fetching unfulfilled orders from Shopify');
    const shopifyClient = createShopifyClient(shopifyUrl, shopifyToken);
    const orders = await getUnfulfilledOrders(shopifyClient, tenant.orderSortDirection as any);

    // Filter already-processed orders
    const existingLabels = await db.label.findMany({
      where: { tenantId, status: { in: ['CREATED', 'COMPLETED'] } },
      select: { shopifyOrderId: true },
    });
    const existingIds = new Set(existingLabels.map(l => l.shopifyOrderId));
    const newOrders = orders.filter(o => !existingIds.has(String(o.id)));

    // Apply max limit
    const maxOrders = tenant.maxOrdersPerRun ?? 20;
    const limitedOrders = newOrders.slice(0, maxOrders);
    totalOrders = limitedOrders.length;

    slog.info(
      'shopify',
      `Found ${orders.length} unfulfilled, ${newOrders.length} new, processing ${totalOrders} (max ${maxOrders})`,
    );

    if (totalOrders === 0) {
      slog.info('complete', 'No new orders to process');
      await db.job.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          totalOrders: 0,
          finishedAt: new Date(),
          durationMs: Date.now() - startTime,
        },
      });
      return;
    }

    // 2. Generate bulk xlsx
    slog.info('bulk-xlsx', `Generating xlsx for ${totalOrders} orders`);
    const xlsxResult = generateBulkXlsx(
      limitedOrders,
      tenant.paymentThreshold,
      tenant.paymentRuleEnabled,
    );

    slog.info(
      'bulk-xlsx',
      `Xlsx generated: ${xlsxResult.includedRows.length} eligible for bulk, ` +
        `${xlsxResult.fallbackRows.length} need individual fallback, ` +
        `size=${xlsxResult.xlsxBuffer.length}b`,
    );

    // 3. Handle fallback rows — save as FAILED with descriptive message
    for (const row of xlsxResult.fallbackRows) {
      try {
        const { safeCity, safeDepartment } = buildSafeLabelGeoFields({
          city: '',
          province: null,
          resolvedDepartment: '',
        });
        await db.label.upsert({
          where: {
            tenantId_shopifyOrderId: { tenantId, shopifyOrderId: String(row.orderId) },
          },
          create: {
            tenantId,
            jobId,
            shopifyOrderId: String(row.orderId),
            shopifyOrderName: row.orderName,
            customerName: row.nombre,
            deliveryAddress: row.direccion,
            city: safeCity,
            department: safeDepartment,
            totalUyu: 0,
            paymentType: 'DESTINATARIO',
            status: 'FAILED',
            errorMessage: `Bulk mapping failed: ${row.fallbackReason}. Retry individually.`,
          },
          update: {
            status: 'FAILED',
            errorMessage: `Bulk mapping failed: ${row.fallbackReason}. Retry individually.`,
          },
        });
        fallbackCount++;
      } catch (err) {
        slog.error('fallback-save', `Failed to save fallback label for ${row.orderName}: ${(err as Error).message}`);
        fallbackCount++;
      }
    }

    // 4. If there are no bulk-eligible rows, nothing for the agent to do
    if (xlsxResult.includedRows.length === 0) {
      slog.warn('complete', `All ${fallbackCount} orders need individual fallback — agent has nothing to do`);
      await db.job.update({
        where: { id: jobId },
        data: {
          status: fallbackCount > 0 ? 'FAILED' : 'COMPLETED',
          totalOrders,
          failedCount: fallbackCount,
          finishedAt: new Date(),
          durationMs: Date.now() - startTime,
          errorMessage:
            fallbackCount > 0
              ? `All ${fallbackCount} orders needed individual fallback (no bulk-eligible rows)`
              : null,
        },
      });
      return;
    }

    // 5. Upload xlsx to Supabase Storage for the agent
    slog.info('storage-upload', `Uploading xlsx to Supabase Storage for agent pickup`);
    const uploadResult = await uploadBulkXlsxToStorage(tenantId, jobId, xlsxResult.xlsxBuffer);

    if (uploadResult.error) {
      slog.error('storage-upload', `Storage upload failed: ${uploadResult.error}`);
      await db.job.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          totalOrders,
          failedCount: totalOrders,
          finishedAt: new Date(),
          durationMs: Date.now() - startTime,
          errorMessage: `Storage upload failed: ${uploadResult.error}`,
        },
      });
      return;
    }

    slog.success('storage-upload', `Xlsx uploaded to ${uploadResult.path}`);

    // 6. Hand off to agent — mark WAITING_FOR_AGENT with xlsxStoragePath set
    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'WAITING_FOR_AGENT',
        totalOrders,
        failedCount: fallbackCount, // preliminary — agent will update with actual DAC results
        xlsxStoragePath: uploadResult.path,
        // Intentionally DO NOT set finishedAt / durationMs — agent will set those
      },
    });

    slog.success(
      'handoff',
      `Handed off to agent: ${xlsxResult.includedRows.length} orders for DAC bulk, ` +
        `${fallbackCount} fallback failures. Waiting for agent to process...`,
    );
  } catch (err) {
    logger.error({ jobId, error: (err as Error).message }, 'Bulk job (Render side) crashed');
    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        totalOrders,
        failedCount: totalOrders,
        finishedAt: new Date(),
        durationMs: Date.now() - startTime,
        errorMessage: (err as Error).message?.slice(0, 500),
      },
    });
  }
}
