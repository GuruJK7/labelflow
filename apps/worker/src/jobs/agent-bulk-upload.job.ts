/**
 * Agent-side per-order job (formerly "bulk upload", now per-order Playwright).
 *
 * Runs on Adrian's Mac, not Render. Polls for WAITING_FOR_AGENT jobs, downloads
 * the orders JSON that Render prepared, then — instead of trying the broken
 * DAC bulk endpoint — processes each order sequentially via Playwright on the
 * real Mac Chrome (which DAC treats as a normal user).
 *
 * Why this file is still named agent-bulk-upload.job.ts: to avoid touching
 * every importer during the migration. The exported functions are the agent
 * entry points that `index.ts` wires into the polling loop.
 *
 * Current behavior:
 *   - GREEN labels: deterministic Playwright flow via `createShipment()`.
 *   - YELLOW labels: Claude corrects ambiguous address fields (city→dept, apt
 *     extraction, phone), then `createShipment()` fills the DAC form using the
 *     override. Claude never opens a browser — it only returns corrected fields.
 *     If Claude cannot resolve, the label is routed to NEEDS_REVIEW.
 *   - RED labels were already marked NEEDS_REVIEW on the Render side — we skip
 *     them here and email the tenant.
 */

import { promises as fs } from 'fs';
import path from 'path';

import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { getConfig } from '../config';
import { downloadOrdersJsonFromStorage } from '../storage/upload';
import { uploadLabelPdf } from '../storage/upload';
import { createStepLogger } from '../logger';
import logger from '../logger';
import { sleep } from '../utils';
import { dacBrowser } from '../dac/browser';
import { smartLogin } from '../dac/auth';
import { createShipment, DacAddressRejectedError } from '../dac/shipment';
import { markAddressResolutionFeedback } from '../dac/ai-resolver';
import { downloadLabel } from '../dac/label';
import { createShopifyClient } from '../shopify/client';
import { markOrderProcessed, addOrderNote } from '../shopify/orders';
import { fulfillOrderWithTracking } from '../shopify/fulfillment';
import { sendShipmentNotification } from '../notifier/email';
import fsSync from 'fs';

import type { AgentJobPayload } from './process-orders-bulk.job';
import { resolveAddressCorrection } from '../agent/invoke-claude';

const DELAY_BETWEEN_ORDERS_MS = 500;

/**
 * AGENT_DRY_RUN=true skips all DAC + Shopify + email side effects and
 * produces fake guías. Used to validate the handoff / classification /
 * storage / polling pipeline on a developer Mac without creating real
 * shipments or sending customer emails.
 *
 * Read fresh each invocation so tests can toggle it mid-session.
 */
function isDryRun(): boolean {
  return process.env.AGENT_DRY_RUN === 'true';
}

/**
 * LABELFLOW_SKIP_SHOPIFY=true skips all Shopify writes (fulfillment, tag/note,
 * and the shipment email notification) while still running the full DAC path
 * and downloading PDFs. Used for real-DAC integration testing without touching
 * the merchant's Shopify store. Unlike AGENT_DRY_RUN, DAC shipments ARE
 * created.
 *
 * Read fresh each invocation so tests can toggle it mid-session.
 */
function isSkipShopify(): boolean {
  return process.env.LABELFLOW_SKIP_SHOPIFY === 'true';
}

function makeFakeGuia(jobId: string, index: number): string {
  // Prefix PENDING- is already recognized elsewhere as "not a real guia" —
  // reuse that convention so downstream skip logic (PDF download, fulfill,
  // tagging, email) automatically kicks in and we don't accidentally call
  // Shopify even if someone forgets a guard.
  return `PENDING-DRY-${jobId.slice(0, 6)}-${index.toString().padStart(3, '0')}`;
}

/**
 * Atomically claim one WAITING_FOR_AGENT job.
 */
async function claimNextAgentJob(): Promise<{ id: string; tenantId: string; xlsxStoragePath: string } | null> {
  const candidate = await db.job.findFirst({
    where: {
      status: 'WAITING_FOR_AGENT',
      xlsxStoragePath: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, tenantId: true, xlsxStoragePath: true },
  });

  if (!candidate || !candidate.xlsxStoragePath) return null;

  const claimed = await db.job.updateMany({
    where: { id: candidate.id, status: 'WAITING_FOR_AGENT' },
    data: {
      status: 'UPLOADING',
      agentPickedAt: new Date(),
    },
  });

  if (claimed.count === 0) return null;
  return {
    id: candidate.id,
    tenantId: candidate.tenantId,
    xlsxStoragePath: candidate.xlsxStoragePath,
  };
}

export async function agentBulkUploadJob(job: {
  id: string;
  tenantId: string;
  xlsxStoragePath: string;
}): Promise<void> {
  const startTime = Date.now();
  const slog = createStepLogger(job.id, job.tenantId);

  let successCount = 0;
  let failedCount = 0;
  let needsReviewCount = 0;

  try {
    slog.info('agent-start', `Agent picked up job ${job.id} (tenant=${job.tenantId})`);

    // 1. Load tenant config (DAC + Shopify + email)
    const tenant = await db.tenant.findUnique({ where: { id: job.tenantId } });
    if (!tenant) throw new Error('Tenant not found');

    const dacUsername = tenant.dacUsername;
    const dacPassword = decryptIfPresent(tenant.dacPassword);
    const shopifyToken = decryptIfPresent(tenant.shopifyToken);
    if (!dacUsername || !dacPassword) throw new Error('Missing DAC credentials');
    if (!tenant.shopifyStoreUrl || !shopifyToken) throw new Error('Missing Shopify credentials');

    // 2. Download payload JSON
    slog.info('agent-download', `Downloading agent payload from ${job.xlsxStoragePath}`);
    const { payload, error } = await downloadOrdersJsonFromStorage<AgentJobPayload>(
      job.xlsxStoragePath,
    );
    if (error || !payload) throw new Error(`Payload download failed: ${error ?? 'empty'}`);
    if (payload.version !== 2) {
      throw new Error(`Unsupported agent payload version: ${String(payload.version)}`);
    }
    const entries = payload.orders ?? [];
    slog.info('agent-download', `Payload has ${entries.length} orders to process`);

    if (entries.length === 0) {
      await db.job.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          durationMs: Date.now() - startTime,
        },
      });
      return;
    }

    const dryRun = isDryRun();
    if (dryRun) {
      slog.warn(
        'dry-run',
        'AGENT_DRY_RUN=true — skipping DAC login / createShipment / Shopify fulfill / email. Fake guías only.',
      );
    }

    const skipShopify = isSkipShopify();
    if (skipShopify) {
      slog.warn(
        'skip-shopify',
        'LABELFLOW_SKIP_SHOPIFY=true — DAC will run normally but Shopify fulfillment / tag / email are skipped.',
      );
    }

    // 3. Launch browser + login (skipped in dry-run)
    const shopifyClient = createShopifyClient(tenant.shopifyStoreUrl, shopifyToken);
    // `page` is unused in dry-run but createShipment needs a Playwright Page
    // in the live path — we only start the browser when we'll actually touch DAC.
    // Use `any` locally to avoid a cascade of nullable types below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let page: any = null;
    if (!dryRun) {
      page = await dacBrowser.getPage();
      try {
        await smartLogin(page, dacUsername, dacPassword, job.tenantId);
        slog.success('dac-login', 'DAC login successful');
      } catch (err) {
        await dacBrowser.close();
        throw new Error(`DAC login failed: ${(err as Error).message}`);
      }
    }

    // 4. Process each order sequentially
    const config = getConfig();
    const tmpDir = path.join(config.LABELS_TMP_DIR, new Date().toISOString().split('T')[0]);

    // Build usedGuias set to prevent cross-batch collisions
    const existingGuias = await db.label.findMany({
      where: { tenantId: job.tenantId, dacGuia: { not: null } },
      select: { dacGuia: true },
    });
    const usedGuias = new Set<string>(
      existingGuias.map((l) => l.dacGuia!).filter((g) => !g.startsWith('PENDING-')),
    );

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const order = entry.order;
      const paymentType = entry.paymentType;
      const labelId = entry.labelId;
      const cls = entry.classification;

      slog.info(
        'order-start',
        `Processing ${i + 1}/${entries.length}: ${order.name} [${cls.zone}${cls.reasons.length ? ' ' + cls.reasons.join(',') : ''}]`,
      );

      let result: { guia: string; trackingUrl?: string; aiResolutionHash?: string } | undefined;

      try {
        // Reuse existing guia if label already has one from a failed downstream run
        const existingLabel = await db.label.findUnique({
          where: { id: labelId },
          select: { dacGuia: true, status: true },
        });

        if (
          existingLabel?.dacGuia &&
          !existingLabel.dacGuia.startsWith('PENDING-') &&
          existingLabel.status === 'FAILED'
        ) {
          slog.warn(
            'order-shipment',
            `Label ${labelId} already has guia ${existingLabel.dacGuia} — skipping DAC form, reusing`,
          );
          result = { guia: existingLabel.dacGuia };
          usedGuias.add(result.guia);
        } else if (dryRun) {
          // Dry-run: synthesize a fake guía and skip all DAC interaction.
          // The PENDING- prefix triggers the downstream "skip PDF / skip
          // fulfill / skip tag / skip email" guards already in the live path.
          const fakeGuia = makeFakeGuia(job.id, i);
          result = { guia: fakeGuia };
          slog.info('order-dry-run', `Dry-run: fake guía ${fakeGuia} for ${order.name}`);
        } else if (cls.zone === 'YELLOW') {
          // YELLOW: Claude corrects ambiguous address fields, worker fills DAC
          // form via the standard Playwright path. Claude never touches DAC.
          const correctionStart = Date.now();
          const override = await resolveAddressCorrection({
            entry,
            jobId: job.id,
            slog,
          });
          const correctionMs = Date.now() - correctionStart;

          // Shadow mode: log full correction detail for monitoring / comparison.
          // Enable with LABELFLOW_YELLOW_SHADOW=true on the Mac Mini.
          if (process.env.LABELFLOW_YELLOW_SHADOW === 'true') {
            slog.info('yellow-shadow', 'Address correction result (shadow logging enabled)', {
              override: override ?? 'null (unresolvable)',
              correctionMs,
              reasons: cls.reasons,
              originalCity: order.shipping_address?.city,
              originalProvince: order.shipping_address?.province,
              originalAddress1: order.shipping_address?.address1,
            });
          }

          if (!override) {
            // Claude couldn't resolve — route to manual review, no throw.
            slog.warn(
              'order-yellow-unresolvable',
              `YELLOW order ${order.name} could not be resolved by Claude — marking NEEDS_REVIEW`,
            );
            await db.label.update({
              where: { id: labelId },
              data: {
                status: 'NEEDS_REVIEW',
                errorMessage: 'Address correction failed — manual review required',
              },
            });
            continue;
          }

          slog.info(
            'order-yellow-override',
            `YELLOW ${order.name}: Claude corrected in ${correctionMs}ms`,
            { ...override },
          );

          result = await createShipment(
            page,
            order,
            paymentType,
            dacUsername,
            dacPassword,
            job.tenantId,
            job.id,
            usedGuias,
            override,
          );
          if (result.guia && !result.guia.startsWith('PENDING-')) {
            usedGuias.add(result.guia);
          }
        } else {
          // GREEN: deterministic Playwright flow on the worker's browser.
          result = await createShipment(
            page,
            order,
            paymentType,
            dacUsername,
            dacPassword,
            job.tenantId,
            job.id,
            usedGuias,
          );
          if (result.guia && !result.guia.startsWith('PENDING-')) {
            usedGuias.add(result.guia);
          }
        }

        slog.success('order-shipment', `DAC shipment created for ${order.name}`, { guia: result.guia });

        // Update label with guia, mark CREATED
        await db.label.update({
          where: { id: labelId },
          data: {
            dacGuia: result.guia,
            status: 'CREATED',
            errorMessage: null,
          },
        });

        // Download PDF (skip if PENDING guia)
        if (result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            const labelLocalPath = await downloadLabel(page, result.guia, tmpDir, dacUsername, dacPassword);
            if (labelLocalPath && fsSync.existsSync(labelLocalPath)) {
              const pdfBuffer = fsSync.readFileSync(labelLocalPath);
              const upload = await uploadLabelPdf(job.tenantId, labelId, pdfBuffer);
              if (!upload.error) {
                await db.label.update({
                  where: { id: labelId },
                  data: { pdfPath: upload.path, status: 'COMPLETED' },
                });
                slog.info('order-pdf', `PDF uploaded for ${order.name}`, { path: upload.path });
              }
              try {
                fsSync.unlinkSync(labelLocalPath);
              } catch {
                /* best-effort cleanup */
              }
            }
          } catch (dlErr) {
            slog.warn('order-pdf', `PDF download failed (non-fatal): ${(dlErr as Error).message}`);
          }
        }

        // Shopify fulfillment
        let fulfillMode = 'on';
        try {
          const raw = await db.$queryRaw<{ fulfillMode: string }[]>`SELECT "fulfillMode" FROM "Tenant" WHERE id = ${job.tenantId}`;
          if (raw[0]?.fulfillMode) fulfillMode = raw[0].fulfillMode;
        } catch {
          /* fallback */
        }
        const shouldFulfill = fulfillMode !== 'off';
        const forceAll = fulfillMode === 'always';
        if (!skipShopify && shouldFulfill && result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            await fulfillOrderWithTracking(
              shopifyClient,
              order.id,
              result.guia,
              result.trackingUrl,
              forceAll,
            );
            slog.success('order-fulfill', `Shopify fulfilled: ${order.name}`);
          } catch (fulfillErr) {
            slog.warn(
              'order-fulfill',
              `Fulfillment failed (non-fatal): ${(fulfillErr as Error).message}`,
            );
          }
        } else if (skipShopify) {
          slog.info('order-fulfill', `SKIP_SHOPIFY: not fulfilling ${order.name} (guia=${result.guia})`);
        }

        // Shopify tag
        if (!skipShopify && result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            await markOrderProcessed(shopifyClient, order.id, result.guia);
          } catch (tagErr) {
            slog.warn('order-shopify', `Tag failed (non-fatal): ${(tagErr as Error).message}`);
          }
        } else if (skipShopify) {
          slog.info('order-shopify', `SKIP_SHOPIFY: not tagging ${order.name} (guia=${result.guia})`);
        }

        // Email notification — NEVER send in dry-run / skip-shopify, or with a
        // PENDING guía (we would email the customer a fake or incomplete tracking).
        const canSendEmail =
          !dryRun && !skipShopify && !!result.guia && !result.guia.startsWith('PENDING-');
        if (canSendEmail && tenant.emailHost && tenant.emailUser) {
          const emailPass = decryptIfPresent(tenant.emailPass);
          if (emailPass) {
            const emailSent = await sendShipmentNotification(
              order,
              result.guia,
              paymentType,
              tenant.storeName ?? tenant.name,
              {
                host: tenant.emailHost,
                port: tenant.emailPort ?? 587,
                user: tenant.emailUser,
                pass: emailPass,
                from: tenant.emailFrom ?? tenant.emailUser,
              },
            );
            if (emailSent) {
              await db.label.update({
                where: { id: labelId },
                data: { emailSent: true, emailSentAt: new Date() },
              });
            }
          }
        }

        // AI resolver feedback
        if (result.aiResolutionHash) {
          await markAddressResolutionFeedback(job.tenantId, result.aiResolutionHash, true, result.guia);
        }

        successCount++;
      } catch (err) {
        if (result?.guia && !result.guia.startsWith('PENDING-')) {
          usedGuias.add(result.guia);
        }

        const errorMsg = (err as Error).message;
        // 2026-04-22 post-run audit: same treatment as process-orders.job.ts —
        // when DAC silently rejects the form because the Shopify address can't
        // be classified into a dept+barrio, mark the Label as NEEDS_REVIEW
        // (not FAILED) and write a Spanish operator-friendly note instead of
        // dumping the raw English error on the Shopify order.
        const isDacAddressRejected = err instanceof DacAddressRejectedError;
        const shipAddr = order.shipping_address;

        if (result?.aiResolutionHash) {
          await markAddressResolutionFeedback(
            job.tenantId,
            result.aiResolutionHash,
            false,
            undefined,
            errorMsg.slice(0, 500),
          );
        }

        if (isDacAddressRejected) {
          slog.warn('order-fail', `Order ${order.name}: DAC rejected form — address confusa, needs operator to contact customer`, {
            orderName: order.name,
            shopifyCity: shipAddr?.city,
            shopifyAddress1: shipAddr?.address1,
            shopifyAddress2: shipAddr?.address2,
            shopifyZip: shipAddr?.zip,
          });
        } else {
          slog.error('order-fail', `Order ${order.name} failed: ${errorMsg}`);
        }

        await db.label
          .update({
            where: { id: labelId },
            data: {
              status: isDacAddressRejected ? 'NEEDS_REVIEW' : 'FAILED',
              errorMessage: isDacAddressRejected
                ? 'Dirección del cliente en Shopify no se pudo interpretar — contactar al cliente para corregirla y reprocesar.'
                : errorMsg.slice(0, 500),
            },
          })
          .catch(() => {});

        // Don't pollute real Shopify orders with notes in dry-run
        if (!dryRun) {
          const noteText = isDacAddressRejected
            ? `LabelFlow: no se pudo crear el envío en DAC — dirección confusa o incompleta en Shopify ` +
              `(ciudad="${shipAddr?.city ?? ''}", dirección="${shipAddr?.address1 ?? ''}"${shipAddr?.address2 ? `, referencia="${shipAddr.address2}"` : ''}). ` +
              `DAC rechazó el formulario porque la localidad/barrio no pudo identificarse. ` +
              `Acción: contactar al cliente para corregir la dirección en Shopify y el worker la va a reprocesar solo en el próximo ciclo.`
            : `LabelFlow ERROR: ${errorMsg.slice(0, 200)}`;
          try {
            // Prevent duplicate-note spam across retries: skip if the same
            // prefix already exists on the order.
            const { data } = await shopifyClient.get(`/orders/${order.id}.json`);
            const currentNote: string = data.order?.note ?? '';
            if (!currentNote.includes(noteText.substring(0, 80))) {
              await addOrderNote(shopifyClient, order.id, noteText);
            }
          } catch {
            /* ignore note errors */
          }
        }

        failedCount++;
      }

      if (i < entries.length - 1) {
        await sleep(DELAY_BETWEEN_ORDERS_MS);
      }
    }

    // 5. Save cookies and close browser (only if we actually opened one)
    if (!dryRun) {
      await dacBrowser.saveCookies(job.tenantId);
      await dacBrowser.close();
    }

    // 6. Count RED (NEEDS_REVIEW) labels from this job for tenant visibility
    needsReviewCount = await db.label.count({
      where: { jobId: job.id, status: 'NEEDS_REVIEW' },
    });

    // 7. Final status
    const durationMs = Date.now() - startTime;
    const status: 'COMPLETED' | 'PARTIAL' | 'FAILED' =
      failedCount === 0 && needsReviewCount === 0 && successCount > 0
        ? 'COMPLETED'
        : successCount > 0
        ? 'PARTIAL'
        : 'FAILED';

    await db.job.update({
      where: { id: job.id },
      data: {
        status,
        successCount: { increment: successCount },
        failedCount: { increment: failedCount },
        finishedAt: new Date(),
        durationMs,
        errorMessage:
          needsReviewCount > 0
            ? `${needsReviewCount} order(s) routed to NEEDS_REVIEW`
            : failedCount > 0
            ? `${failedCount} order(s) failed`
            : null,
      },
    });

    // Don't inflate real usage counters in dry-run — only record the timestamp
    await db.tenant
      .update({
        where: { id: job.tenantId },
        data: dryRun
          ? { lastRunAt: new Date() }
          : {
              labelsThisMonth: { increment: successCount },
              labelsTotal: { increment: successCount },
              lastRunAt: new Date(),
            },
      })
      .catch(() => {});

    slog.success(
      'agent-complete',
      `Done: ${successCount} success, ${failedCount} failed, ${needsReviewCount} NEEDS_REVIEW in ${Math.round(durationMs / 1000)}s`,
    );
  } catch (err) {
    const errorMsg = (err as Error).message;
    logger.error({ jobId: job.id, error: errorMsg }, 'Agent per-order flow crashed');

    await dacBrowser.close().catch(() => {});

    await db.job
      .update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          failedCount: { increment: 1 },
          finishedAt: new Date(),
          durationMs: Date.now() - startTime,
          errorMessage: errorMsg.slice(0, 500),
        },
      })
      .catch(() => {});
  } finally {
    // Best-effort cleanup of any stale tmp artifacts from old bulk flow
    await fs.unlink('/tmp/labelflow-job-context.json').catch(() => {});
    await fs.unlink('/tmp/labelflow-job-result.json').catch(() => {});
  }
}

/**
 * Agent polling loop. Only runs when AGENT_MODE=true in env.
 * Polls every 30 seconds for WAITING_FOR_AGENT jobs.
 */
export async function pollAgentBulkJobs(): Promise<void> {
  try {
    const job = await claimNextAgentJob();
    if (!job) return;

    logger.info({ jobId: job.id }, '[Agent] Claimed job, processing...');
    await agentBulkUploadJob(job);
  } catch (err) {
    logger.error({ error: (err as Error).message }, '[Agent] Poll cycle error');
  }
}
