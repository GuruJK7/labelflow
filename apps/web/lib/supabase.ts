import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supabase: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient {
  if (_supabase) return _supabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase env vars not set (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  }
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'labels';

/**
 * Generates a signed URL for a file in Supabase Storage.
 * Expires in 1 hour.
 */
export async function getSignedUrl(path: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin().storage
    .from(BUCKET)
    .createSignedUrl(path, 3600);

  if (error) {
    console.error('Supabase signed URL error:', error.message);
    return null;
  }

  return data.signedUrl;
}

/**
 * Uploads a PDF buffer to Supabase Storage.
 */
export async function uploadPdf(
  path: string,
  buffer: Buffer
): Promise<{ path: string; error: string | null }> {
  const { error } = await getSupabaseAdmin().storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (error) {
    return { path: '', error: error.message };
  }

  return { path, error: null };
}
