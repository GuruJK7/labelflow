/**
 * Bulk order processing job — AGENT-BASED architecture v2 (per-order).
 *
 * Historical context: v1 of this file generated an xlsx and uploaded it to the
 * DAC `/envios/masivos` endpoint through the agent. After extensive testing
 * (13 xlsx variants across 3 libraries), we confirmed DAC's bulk endpoint is
 * broken for 2+ row uploads regardless of xlsx format. The endpoint consistently
 * returns "Entrega Fila 2" for any file with more than one data row. There is
 * no known xlsx format that the endpoint accepts in bulk.
 *
 * v2 (this file) replaces xlsx with per-order Playwright processing on the
 * agent (Adrian's Mac). Render still prepares the batch:
 *
 *   1. Worker picks up a PROCESS_ORDERS_BULK job (status=PENDING)
 *   2. Fetches Shopify orders (same filtering as v1)
 *   3. Classifies each order (GREEN/YELLOW/RED) via order-classifier.ts
 *   4. Pre-creates Label rows:
 *        GREEN/YELLOW → PENDING (agent will process)
 *        RED          → NEEDS_REVIEW (cannot ship; tenant must review)
 *   5. Uploads the batch as JSON to Supabase Storage at
 *        agent-orders/{tenantId}/{jobId}.json
 *   6. Marks the Job WAITING_FOR_AGENT with xlsxStoragePath set to the JSON
 *      path (we reuse the existing field to avoid a schema migration).
 *   7. Agent (Mac) polls WAITING_FOR_AGENT, downloads JSON, runs Playwright
 *      per-order for each GREEN/YELLOW, skips RED (already NEEDS_REVIEW).
 */

import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { createShopifyClient } from '../shopify/client';
import { getUnfulfilledOrders } from '../shopify/orders';
import { uploadOrdersJsonToStorage } from '../storage/upload';
import { createStepLogger } from '../logger';
import { buildSafeLabelGeoFields } from './label-safe-fields';
import { classifyOrders, type ClassifiedOrder } from '../rules/order-classifier';
import { determinePaymentType } from '../rules/payment';
import { evaluateShippingRules, type ShippingRuleRow } from '../rules/shipping';
import { mergeAddress } from '../dac/shipment';
import { getDepartmentForCityAsync } from '../dac/uruguay-geo';
import type { ShopifyOrder } from '../shopify/types';
import logger from '../logger';

/**
 * Shape of the JSON payload the agent downloads from Storage.
 * Keep this stable — the Mac worker parses it.
 */
export interface AgentJobPayload {
  version: 2;
  jobId: string;
  tenantId: string;
  createdAt: string;
  orders: Array<{
    order: ShopifyOrder;
    classification: ClassifiedOrder;
    labelId: string;
    paymentType: 'REMITENTE' | 'DESTINATARIO';
  }>;
}

export async function processOrdersBulkJob(tenantId: string, jobId: string): Promise<void> {
  const startTime = Date.now();
  let totalOrders = 0;
  let redCount = 0;

  const slog = createStepLogger(jobId, tenantId);

  try {
    await db.job.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // Load tenant config (+ active shipping rules, sorted by evaluation order)
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
      await db.job.update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: 'Tenant not found', finishedAt: new Date() },
      });
      return;
    }

    const shopifyUrl = tenant.shopifyStoreUrl;
    const shopifyToken = decryptIfPresent(tenant.shopifyToken);

    if (!shopifyUrl || !shopifyToken) {
      slog.error('config', 'Missing Shopify credentials');
      await db.job.update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: 'Missing Shopify credentials', finishedAt: new Date() },
      });
      return;
    }

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
    const orders = await getUnfulfilledOrders(
      shopifyClient,
      (tenant.orderSortDirection as 'oldest_first' | 'newest_first') ?? 'oldest_first',
    );

    // 2. Filter already-processed
    const existingLabels = await db.label.findMany({
      where: { tenantId, status: { in: ['CREATED', 'COMPLETED'] } },
      select: { shopifyOrderId: true },
    });
    const existingIds = new Set(existingLabels.map((l) => l.shopifyOrderId));
    const newOrders = orders.filter((o) => !existingIds.has(String(o.id)));

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

    // 3. Classify each order (GREEN/YELLOW/RED)
    const classified = classifyOrders(limitedOrders);
    slog.info(
      'classify',
      `Zones: ${classified.green.length} GREEN, ${classified.yellow.length} YELLOW, ${classified.red.length} RED`,
    );

    // Build a lookup from orderId → classification
    const classByOrderId = new Map<string, ClassifiedOrder>();
    for (const c of [...classified.green, ...classified.yellow, ...classified.red]) {
      classByOrderId.set(c.orderId, c);
    }

    // 4. Pre-create Label rows per classification
    const payloadEntries: AgentJobPayload['orders'] = [];

    for (const order of limitedOrders) {
      const orderId = String(order.id);
      const cls = classByOrderId.get(orderId);
      if (!cls) continue;

      const addr = order.shipping_address;
      const customerName = addr
        ? `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente'
        : 'Sin datos';
      const totalUyu = parseFloat(order.total_price) || 0;

      // Decide REMITENTE vs DESTINATARIO.
      // 1) New ShippingRule engine — first active rule that matches wins.
      // 2) Legacy fields — paymentRuleEnabled + paymentThreshold + consolidation.
      //    Bulk job mirrors the same decision tree used by process-orders.job.ts
      //    so single-order and bulk flows agree on payment type for any given order.
      let paymentType: 'REMITENTE' | 'DESTINATARIO';
      const ruleResult = await evaluateShippingRules(
        tenant.shippingRules as unknown as ShippingRuleRow[],
        { order, tenantId, db },
      );
      if (ruleResult.paymentType === 'REMITENTE') {
        paymentType = 'REMITENTE';
      } else {
        paymentType = determinePaymentType(order, tenant.paymentThreshold, tenant.paymentRuleEnabled);
        if (paymentType === 'DESTINATARIO' && tenant.consolidateConsecutiveOrders && order.email) {
          const windowMs = (tenant.consolidationWindowMinutes ?? 30) * 60 * 1000;
          const windowStart = new Date(Date.now() - windowMs);
          const priorOrder = await db.label.findFirst({
            where: {
              tenantId,
              customerEmail: order.email,
              status: { in: ['PENDING', 'COMPLETED', 'CREATED'] },
              shopifyOrderId: { not: orderId },
              createdAt: { gte: windowStart },
            },
            select: { id: true },
          });
          if (priorOrder) paymentType = 'REMITENTE';
        }
      }

      const { fullAddress: mergedAddr } = addr?.address1
        ? mergeAddress(addr.address1, addr.address2)
        : { fullAddress: '' };
      const resolvedDeptRaw = await getDepartmentForCityAsync(addr?.city ?? '');
      const { safeCity, safeDepartment } = buildSafeLabelGeoFields({
        city: addr?.city ?? '',
        province: addr?.province ?? null,
        resolvedDepartment: resolvedDeptRaw,
      });

      if (cls.zone === 'RED') {
        // Cannot ship — mark NEEDS_REVIEW, don't include in agent payload
        const upserted = await db.label.upsert({
          where: {
            tenantId_shopifyOrderId: { tenantId, shopifyOrderId: orderId },
          },
          create: {
            tenantId,
            jobId,
            shopifyOrderId: orderId,
            shopifyOrderName: order.name,
            customerName,
            customerEmail: order.email,
            customerPhone: addr?.phone,
            deliveryAddress: mergedAddr,
            city: safeCity,
            department: safeDepartment,
            totalUyu,
            paymentType,
            status: 'NEEDS_REVIEW',
            errorMessage: `Needs review: ${cls.summary}`,
          },
          update: {
            jobId,
            status: 'NEEDS_REVIEW',
            errorMessage: `Needs review: ${cls.summary}`,
          },
        });
        slog.warn(
          'label-red',
          `Order ${order.name} → NEEDS_REVIEW (${cls.reasons.join(', ')}) labelId=${upserted.id}`,
        );
        redCount++;
      } else {
        // GREEN or YELLOW — pre-create as PENDING for agent pickup
        const upserted = await db.label.upsert({
          where: {
            tenantId_shopifyOrderId: { tenantId, shopifyOrderId: orderId },
          },
          create: {
            tenantId,
            jobId,
            shopifyOrderId: orderId,
            shopifyOrderName: order.name,
            customerName,
            customerEmail: order.email,
            customerPhone: addr?.phone,
            deliveryAddress: mergedAddr,
            city: safeCity,
            department: safeDepartment,
            totalUyu,
            paymentType,
            status: 'PENDING',
          },
          update: {
            jobId,
            status: 'PENDING',
            errorMessage: null,
          },
        });
        payloadEntries.push({
          order,
          classification: cls,
          labelId: upserted.id,
          paymentType,
        });
      }
    }

    // 5. If nothing for the agent to do, short-circuit
    if (payloadEntries.length === 0) {
      const failedCount = redCount;
      slog.warn('complete', `All ${totalOrders} orders were RED — no agent work queued`);
      await db.job.update({
        where: { id: jobId },
        data: {
          status: failedCount > 0 ? 'PARTIAL' : 'COMPLETED',
          totalOrders,
          failedCount,
          finishedAt: new Date(),
          durationMs: Date.now() - startTime,
          errorMessage:
            failedCount > 0
              ? `All ${failedCount} orders need manual review (RED zone)`
              : null,
        },
      });
      return;
    }

    // 6. Upload the JSON payload for the agent
    const payload: AgentJobPayload = {
      version: 2,
      jobId,
      tenantId,
      createdAt: new Date().toISOString(),
      orders: payloadEntries,
    };

    slog.info(
      'storage-upload',
      `Uploading agent JSON: ${payloadEntries.length} orders for per-order processing`,
    );
    const uploadResult = await uploadOrdersJsonToStorage(tenantId, jobId, payload);

    if (uploadResult.error) {
      slog.error('storage-upload', `JSON upload failed: ${uploadResult.error}`);
      await db.job.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          totalOrders,
          failedCount: totalOrders,
          finishedAt: new Date(),
          durationMs: Date.now() - startTime,
          errorMessage: `JSON upload failed: ${uploadResult.error}`,
        },
      });
      return;
    }

    slog.success('storage-upload', `Agent JSON uploaded to ${uploadResult.path}`);

    // 7. Hand off: mark WAITING_FOR_AGENT (xlsxStoragePath reused to hold JSON path)
    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'WAITING_FOR_AGENT',
        totalOrders,
        failedCount: redCount, // preliminary — agent updates with final counts
        xlsxStoragePath: uploadResult.path,
        // Intentionally no finishedAt / durationMs — agent sets those
      },
    });

    slog.success(
      'handoff',
      `Handed off to agent: ${payloadEntries.length} GREEN/YELLOW orders; ${redCount} RED routed to NEEDS_REVIEW`,
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
