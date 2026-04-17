/**
 * Agent-side bulk upload job.
 *
 * Runs on Adrian's Mac (not Render). Polls for WAITING_FOR_AGENT jobs,
 * downloads the xlsx that Render prepared, then SPAWNS Claude Code CLI with
 * the `process-bulk-dac` skill to do the actual DAC interaction via Chrome MCP.
 *
 * Claude Code reads context from /tmp/labelflow-job-context.json, uses Chrome
 * MCP to login + upload + extract guías, writes result to
 * /tmp/labelflow-job-result.json. This worker then:
 *   - updates Labels with guías
 *   - fulfills Shopify orders (marks as fulfilled with tracking URLs)
 *   - marks the Job as COMPLETED
 *
 * Retry policy: up to 2 attempts per job. After 2 failures, marked FAILED.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import { downloadBulkXlsxFromStorage } from '../storage/upload';
import { createStepLogger } from '../logger';
import logger from '../logger';

const MAX_ATTEMPTS = 2;
const CLAUDE_TIMEOUT_MS = 6 * 60 * 1000; // 6 minutes per Claude invocation

interface JobContext {
  jobId: string;
  tenantId: string;
  dacUsername: string;
  dacPassword: string;
  xlsxPath: string;
  expectedRowCount: number;
}

interface ClaudeResult {
  success: boolean;
  guias: string[];
  error: string | null;
  stage?: string;
  dacError?: string;
  expectedCount?: number;
  actualCount?: number;
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
  return { id: candidate.id, tenantId: candidate.tenantId, xlsxStoragePath: candidate.xlsxStoragePath };
}

/**
 * Invokes `claude -p` with the process-bulk-dac skill and waits for the
 * result JSON file to be written. Returns the parsed ClaudeResult.
 *
 * The Max subscription is used — `claude` CLI runs non-interactively with
 * a specific skill, and reads context from a temp file (not stdin) so we
 * avoid leaking credentials via argv.
 */
async function invokeClaudeCode(context: JobContext): Promise<ClaudeResult> {
  const contextPath = '/tmp/labelflow-job-context.json';
  const resultPath = '/tmp/labelflow-job-result.json';

  // Write context file (Claude reads this)
  await fs.writeFile(contextPath, JSON.stringify(context, null, 2), { mode: 0o600 });

  // Delete old result file if exists
  try {
    await fs.unlink(resultPath);
  } catch {
    // Not present — fine
  }

  const prompt = [
    'Execute the process-bulk-dac skill.',
    '',
    'Context file: /tmp/labelflow-job-context.json',
    'Write result to: /tmp/labelflow-job-result.json',
    '',
    'Follow the skill SKILL.md instructions exactly. Do not deviate.',
    'When done, respond with a brief one-line summary only.',
  ].join('\n');

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--skill', 'process-bulk-dac'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timeoutHandle = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude Code timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

    proc.on('close', async (code) => {
      clearTimeout(timeoutHandle);

      logger.info(
        { jobId: context.jobId, exitCode: code, stdoutPreview: stdout.slice(0, 300), stderrPreview: stderr.slice(0, 300) },
        '[Agent] Claude Code process exited',
      );

      // Regardless of exit code, read the result file — the skill writes it even on failure
      try {
        const resultRaw = await fs.readFile(resultPath, 'utf-8');
        const result: ClaudeResult = JSON.parse(resultRaw);
        resolve(result);
      } catch (err) {
        reject(new Error(`Claude Code exited (code=${code}) without writing result file: ${(err as Error).message}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

async function fulfillShopifyOrders(
  tenantId: string,
  jobId: string,
  slog: ReturnType<typeof createStepLogger>,
): Promise<void> {
  // Load tenant + completed Labels with guías (created by the DB update below)
  const labels = await db.label.findMany({
    where: { jobId, dacGuia: { not: null }, status: 'COMPLETED' },
  });

  if (labels.length === 0) {
    slog.warn('shopify-fulfill', 'No completed labels with guías to fulfill');
    return;
  }

  slog.info('shopify-fulfill', `Fulfilling ${labels.length} Shopify orders (marking as shipped)`);

  // Lazy import to avoid pulling in shopify deps on cold start
  const { createShopifyClient } = await import('../shopify/client');
  const { fulfillOrderWithTracking } = await import('../shopify/fulfillment');

  const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.shopifyStoreUrl || !tenant.shopifyToken) {
    slog.warn('shopify-fulfill', 'Tenant missing Shopify creds — skipping fulfillment');
    return;
  }

  const shopifyToken = decryptIfPresent(tenant.shopifyToken);
  if (!shopifyToken) {
    slog.warn('shopify-fulfill', 'Could not decrypt Shopify token — skipping fulfillment');
    return;
  }

  const client = createShopifyClient(tenant.shopifyStoreUrl, shopifyToken);

  for (const label of labels) {
    if (!label.dacGuia) continue; // skip: no guía to attach
    try {
      const orderIdNum = Number(label.shopifyOrderId);
      if (!Number.isInteger(orderIdNum)) {
        slog.warn('shopify-skip', `Invalid orderId "${label.shopifyOrderId}" for label ${label.id} — skipping fulfillment`);
        continue;
      }
      const trackingUrl = `https://www.dac.com.uy/envios/seguimiento?guia=${label.dacGuia}`;
      await fulfillOrderWithTracking(client, orderIdNum, label.dacGuia, trackingUrl);
      slog.info('shopify-fulfilled', `Order ${label.shopifyOrderName} marked fulfilled (guía=${label.dacGuia})`);

      // TODO: re-fetch Shopify order + send customer email. Email requires
      // original order payload (items, totals) which we don't persist on the
      // Label record — deferred to v2.
    } catch (err) {
      slog.error('shopify-fail', `Fulfillment failed for ${label.shopifyOrderName}: ${(err as Error).message}`);
      // Continue with other labels
    }
  }
}

export async function agentBulkUploadJob(job: {
  id: string;
  tenantId: string;
  xlsxStoragePath: string;
}): Promise<void> {
  const startTime = Date.now();
  const slog = createStepLogger(job.id, job.tenantId);

  let attempt = 0;
  let lastError = '';
  let claudeResult: ClaudeResult | null = null;

  try {
    slog.info('agent-start', `Agent picked up job ${job.id} (tenant=${job.tenantId})`);

    // 1. Load tenant DAC credentials
    const tenant = await db.tenant.findUnique({
      where: { id: job.tenantId },
      select: { dacUsername: true, dacPassword: true },
    });

    if (!tenant?.dacUsername || !tenant.dacPassword) {
      throw new Error('Tenant DAC credentials not found');
    }

    const dacUsername = tenant.dacUsername;
    const dacPassword = decryptIfPresent(tenant.dacPassword);
    if (!dacPassword) throw new Error('DAC password failed to decrypt');

    // 2. Download xlsx from Storage to local tmp
    slog.info('agent-download', `Downloading xlsx from ${job.xlsxStoragePath}`);
    const downloaded = await downloadBulkXlsxFromStorage(job.xlsxStoragePath);
    if (downloaded.error || !downloaded.buffer) {
      throw new Error(`Download failed: ${downloaded.error}`);
    }

    const xlsxLocalPath = path.join('/tmp', `labelflow-xlsx-${job.id}.xlsx`);
    await fs.writeFile(xlsxLocalPath, downloaded.buffer, { mode: 0o600 });
    slog.info('agent-xlsx-saved', `Xlsx saved to ${xlsxLocalPath}`);

    // 3. Build context for Claude
    const expectedRowCount = await db.label.count({
      where: { jobId: job.id, status: { in: ['CREATED', 'FAILED'] } },
    });

    const context: JobContext = {
      jobId: job.id,
      tenantId: job.tenantId,
      dacUsername,
      dacPassword,
      xlsxPath: xlsxLocalPath,
      expectedRowCount,
    };

    // 4. Retry loop: up to MAX_ATTEMPTS invocations of Claude
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      slog.info('claude-attempt', `Invoking Claude Code (attempt ${attempt}/${MAX_ATTEMPTS})`);

      try {
        claudeResult = await invokeClaudeCode(context);

        if (claudeResult.success) {
          slog.success('claude-success', `Claude returned ${claudeResult.guias.length} guías on attempt ${attempt}`);
          break;
        } else {
          lastError = claudeResult.error ?? 'Unknown Claude failure';
          slog.warn('claude-fail', `Attempt ${attempt} failed: ${lastError} (stage=${claudeResult.stage})`);
          // Fall through to retry
        }
      } catch (err) {
        lastError = (err as Error).message;
        slog.error('claude-error', `Attempt ${attempt} crashed: ${lastError}`);
        claudeResult = null;
      }
    }

    // 5. Cleanup temp files
    await fs.unlink(xlsxLocalPath).catch(() => {});
    await fs.unlink('/tmp/labelflow-job-context.json').catch(() => {});

    // 6. Process result
    if (!claudeResult?.success) {
      throw new Error(`All ${MAX_ATTEMPTS} Claude attempts failed. Last error: ${lastError}`);
    }

    // 7. Attach guías to Labels
    const guias = claudeResult.guias;
    const pendingLabels = await db.label.findMany({
      where: { jobId: job.id, dacGuia: null, status: { in: ['CREATED', 'FAILED'] } },
      orderBy: { createdAt: 'asc' },
    });

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < guias.length; i++) {
      const guia = guias[i];
      const label = pendingLabels[i];
      if (!label) {
        slog.warn('guia-orphan', `Guía ${guia} has no pending label (index ${i})`);
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
        slog.error('label-update', `Failed to update label ${label.id}: ${(err as Error).message}`);
        failedCount++;
      }
    }

    // 8. Shopify fulfillment (best-effort — don't fail the job if Shopify fails)
    try {
      await fulfillShopifyOrders(job.tenantId, job.id, slog);
    } catch (err) {
      slog.error('shopify-fulfill-fail', `Shopify fulfillment step crashed: ${(err as Error).message}`);
    }

    // 9. Mark job COMPLETED
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

    slog.success('agent-complete', `Done: ${successCount} success, ${failedCount} failed in ${Math.round(durationMs / 1000)}s`);
  } catch (err) {
    const errorMsg = (err as Error).message;
    logger.error({ jobId: job.id, error: errorMsg, lastError, attempts: attempt }, 'Agent bulk upload failed');

    await db.job.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        failedCount: { increment: 1 },
        finishedAt: new Date(),
        durationMs: Date.now() - startTime,
        errorMessage: `${errorMsg} (last Claude error: ${lastError})`.slice(0, 500),
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
