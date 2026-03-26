import { createClient } from '@supabase/supabase-js';
import { getConfig } from '../config';
import logger from '../logger';

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

  const today = new Date().toISOString().split('T')[0];
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
