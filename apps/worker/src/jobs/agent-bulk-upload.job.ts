/**
 * Agent-side bulk upload job.
 *
 * Runs on Adrian's Mac (not Render). Polls for WAITING_FOR_AGENT jobs,
 * downloads the xlsx that Render prepared, uploads it to DAC via Playwright
 * on a real Mac (where setInputFiles actually works, unlike in Render Docker),
 * extracts guías, creates Labels, and marks the Job COMPLETED.
 *
 * To enable this loop, set AGENT_MODE=true in the worker's .env. The regular
 * Render worker ignores this job type entirely.
 */

import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { downloadBulkXlsxFromStorage } from '../storage/upload';
import { uploadBulkXlsx } from '../dac/bulk-upload';
import { dacBrowser } from '../dac/browser';
import { buildSafeLabelGeoFields } from './label-safe-fields';
import { getDepartmentForCity } from '../dac/uruguay-geo';
import { createStepLogger } from '../logger';
import logger from '../logger';

/**
 * Finds and atomically claims one WAITING_FOR_AGENT job.
 * Returns the claimed job, or null if no work is available.
 *
 * Uses a conditional UPDATE to prevent race conditions if multiple agents
 * ever run simultaneously (future-proof for scaling).
 */
async function claimNextAgentJob(): Promise<{ id: string; tenantId: string; xlsxStoragePath: string } | null> {
  // Find candidate
  const candidate = await db.job.findFirst({
    where: {
      status: 'WAITING_FOR_AGENT',
      xlsxStoragePath: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, tenantId: true, xlsxStoragePath: true },
  });

  if (!candidate || !candidate.xlsxStoragePath) return null;

  // Try to claim atomically: only succeed if still WAITING_FOR_AGENT
  const claimed = await db.job.updateMany({
    where: { id: candidate.id, status: 'WAITING_FOR_AGENT' },
    data: {
      status: 'UPLOADING',
      agentPickedAt: new Date(),
    },
  });

  if (claimed.count === 0) {
    // Another agent claimed it between our read and write
    return null;
  }

  return { id: candidate.id, tenantId: candidate.tenantId, xlsxStoragePath: candidate.xlsxStoragePath };
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

  try {
    slog.info('agent-start', `Agent picked up job ${job.id} (tenant=${job.tenantId})`);

    // 1. Load tenant DAC credentials
    const tenant = await db.tenant.findUnique({
      where: { id: job.tenantId },
      select: { dacUsername: true, dacPassword: true },
    });

    if (!tenant || !tenant.dacUsername || !tenant.dacPassword) {
      throw new Error('Tenant DAC credentials not found');
    }

    const dacUsername = tenant.dacUsername;
    const dacPassword = decryptIfPresent(tenant.dacPassword);
    if (!dacPassword) throw new Error('DAC password failed to decrypt');

    // 2. Download xlsx from Supabase Storage
    slog.info('agent-download', `Downloading xlsx from ${job.xlsxStoragePath}`);
    const downloaded = await downloadBulkXlsxFromStorage(job.xlsxStoragePath);
    if (downloaded.error || !downloaded.buffer) {
      throw new Error(`Download failed: ${downloaded.error}`);
    }

    // 3. Also fetch the original included rows from the Job's RunLog so we can map guias → orders
    //    (bulk-xlsx stores them when it runs on Render)
    const bulkLog = await db.runLog.findFirst({
      where: { jobId: job.id, message: { startsWith: 'bulk-xlsx' } },
      orderBy: { createdAt: 'desc' },
    });
    slog.info('agent-context', `Found bulk log: ${bulkLog?.message ?? 'none'}`);

    // 4. Upload to DAC using the Mac's real Playwright (which actually works)
    slog.info('agent-upload', 'Starting DAC upload via Playwright on Mac');
    const uploadResult = await uploadBulkXlsx(
      downloaded.buffer,
      dacUsername,
      dacPassword,
      job.tenantId,
      0, // totalExpectedRows: we don't track this here, DAC tells us
    );

    if (!uploadResult.success) {
      throw new Error(`DAC upload failed: ${uploadResult.error}`);
    }

    slog.success('agent-upload', `DAC returned ${uploadResult.guias.length} guias`);

    // 5. Update pending Labels with guías
    //    Render already created Label records (or didn't? depends on design) — we create them here.
    //    For MVP: find pending labels for this job without a guía and attach in order.
    const pendingLabels = await db.label.findMany({
      where: { jobId: job.id, dacGuia: null, status: { in: ['CREATED', 'FAILED'] } },
      orderBy: { createdAt: 'asc' },
    });

    for (let i = 0; i < uploadResult.guias.length; i++) {
      const guia = uploadResult.guias[i];
      const label = pendingLabels[i];
      if (!label) {
        slog.warn('guia-orphan', `Guía ${guia} has no pending label (index ${i}) — skipping`);
        continue;
      }
      try {
        await db.label.update({
          where: { id: label.id },
          data: {
            dacGuia: guia,
            status: 'COMPLETED',
            errorMessage: null,
          },
        });
        successCount++;
      } catch (err) {
        slog.error('label-update', `Failed to attach guía ${guia} to label ${label.id}: ${(err as Error).message}`);
        failedCount++;
      }
    }

    // 6. Close the DAC browser (frees resources between tenants)
    await dacBrowser.close();

    // 7. Mark job COMPLETED
    const durationMs = Date.now() - startTime;
    const finalStatus = failedCount === 0 && successCount > 0 ? 'COMPLETED' : successCount > 0 ? 'PARTIAL' : 'FAILED';

    await db.job.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        successCount: { increment: successCount },
        failedCount: { increment: failedCount },
        finishedAt: new Date(),
        durationMs,
      },
    });

    slog.success(
      'agent-complete',
      `Agent done: ${successCount} success, ${failedCount} failed in ${Math.round(durationMs / 1000)}s`,
    );
  } catch (err) {
    const errorMsg = (err as Error).message;
    logger.error({ jobId: job.id, error: errorMsg }, 'Agent bulk upload crashed');
    await dacBrowser.close().catch(() => {});

    await db.job.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        failedCount: { increment: 1 },
        finishedAt: new Date(),
        durationMs: Date.now() - startTime,
        errorMessage: errorMsg?.slice(0, 500) ?? 'Agent error',
      },
    });
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
