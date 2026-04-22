import { createClient } from '@supabase/supabase-js';
import { getConfig } from '../config';
import logger from '../logger';
import { localYmd } from '../utils';

function getSupabase() {
  const config = getConfig();
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase not configured');
  }
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Uploads a label PDF to Supabase Storage.
 * Path: {tenantId}/{YYYY-MM-DD}/{labelId}.pdf
 */
export async function uploadLabelPdf(
  tenantId: string,
  labelId: string,
  pdfBuffer: Buffer
): Promise<{ path: string; error: string | null }> {
  const config = getConfig();
  const supabase = getSupabase();

  // M-7 (2026-04-21 audit): bucket by UY-local date so operators looking at
  // "today's labels" at 22:00 UY see them in today's folder, not tomorrow's
  // (which is what UTC would do). See `localYmd` for the full rationale.
  const today = localYmd();
  const storagePath = `${tenantId}/${today}/${labelId}.pdf`;

  const { error } = await supabase.storage
    .from(config.SUPABASE_STORAGE_BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (error) {
    logger.error({ error: error.message, storagePath }, 'Failed to upload PDF to Supabase');
    return { path: '', error: error.message };
  }

  logger.info({ storagePath, tenantId, labelId }, 'PDF uploaded to Supabase Storage');
  return { path: storagePath, error: null };
}

/**
 * Uploads a bulk DAC xlsx to Supabase Storage so Adrian's Mac (agent) can
 * download and process it.
 *
 * Path: bulk-xlsx/{tenantId}/{jobId}.xlsx
 *
 * Used by the agent-based bulk flow:
 *   Render → generates xlsx → uploadBulkXlsxToStorage → WAITING_FOR_AGENT
 *   Agent  → downloads xlsx → uploads to DAC → COMPLETED
 */
export async function uploadBulkXlsxToStorage(
  tenantId: string,
  jobId: string,
  xlsxBuffer: Buffer,
): Promise<{ path: string; error: string | null }> {
  const config = getConfig();
  const supabase = getSupabase();

  const storagePath = `bulk-xlsx/${tenantId}/${jobId}.xlsx`;

  const { error } = await supabase.storage
    .from(config.SUPABASE_STORAGE_BUCKET)
    .upload(storagePath, xlsxBuffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: true,
    });

  if (error) {
    logger.error({ error: error.message, storagePath }, 'Failed to upload bulk xlsx to Supabase');
    return { path: '', error: error.message };
  }

  logger.info({ storagePath, tenantId, jobId, sizeBytes: xlsxBuffer.length }, 'Bulk xlsx uploaded to Supabase Storage');
  return { path: storagePath, error: null };
}

/**
 * Uploads the per-order JSON payload for the Mac agent.
 *
 * Path: agent-orders/{tenantId}/{jobId}.json
 *
 * Used by the NEW per-order agent flow (replacement for the broken bulk
 * xlsx endpoint):
 *   Render → classifies + pre-creates Labels → uploads orders JSON → WAITING_FOR_AGENT
 *   Agent  → downloads JSON → runs Playwright per-order → COMPLETED
 */
export async function uploadOrdersJsonToStorage(
  tenantId: string,
  jobId: string,
  payload: unknown,
): Promise<{ path: string; error: string | null }> {
  const config = getConfig();
  const supabase = getSupabase();

  const storagePath = `agent-orders/${tenantId}/${jobId}.json`;
  const buffer = Buffer.from(JSON.stringify(payload), 'utf-8');

  const { error } = await supabase.storage
    .from(config.SUPABASE_STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'application/json',
      upsert: true,
    });

  if (error) {
    logger.error({ error: error.message, storagePath }, 'Failed to upload agent orders JSON');
    return { path: '', error: error.message };
  }

  logger.info({ storagePath, tenantId, jobId, sizeBytes: buffer.length }, 'Agent orders JSON uploaded');
  return { path: storagePath, error: null };
}

/**
 * Downloads the agent orders JSON. Returns parsed payload or error.
 */
export async function downloadOrdersJsonFromStorage<T = unknown>(
  storagePath: string,
): Promise<{ payload: T | null; error: string | null }> {
  const config = getConfig();
  const supabase = getSupabase();

  const { data, error } = await supabase.storage
    .from(config.SUPABASE_STORAGE_BUCKET)
    .download(storagePath);

  if (error || !data) {
    logger.error({ error: error?.message, storagePath }, 'Failed to download agent orders JSON');
    return { payload: null, error: error?.message ?? 'No data returned' };
  }

  try {
    const text = await data.text();
    const payload = JSON.parse(text) as T;
    logger.info({ storagePath }, 'Agent orders JSON downloaded');
    return { payload, error: null };
  } catch (err) {
    return { payload: null, error: `Parse failure: ${(err as Error).message}` };
  }
}

/**
 * Downloads a bulk DAC xlsx from Supabase Storage. Used by the agent.
 */
export async function downloadBulkXlsxFromStorage(
  storagePath: string,
): Promise<{ buffer: Buffer | null; error: string | null }> {
  const config = getConfig();
  const supabase = getSupabase();

  const { data, error } = await supabase.storage
    .from(config.SUPABASE_STORAGE_BUCKET)
    .download(storagePath);

  if (error || !data) {
    logger.error({ error: error?.message, storagePath }, 'Failed to download bulk xlsx from Supabase');
    return { buffer: null, error: error?.message ?? 'No data returned' };
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  logger.info({ storagePath, sizeBytes: buffer.length }, 'Bulk xlsx downloaded from Supabase Storage');
  return { buffer, error: null };
}
