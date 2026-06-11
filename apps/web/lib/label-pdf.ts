/**
 * Create a short-lived Supabase signed URL for a label PDF in the `labels`
 * bucket. Shared by the multi-store control PDF route. Returns the signed URL
 * string, or null if storage is not configured / signing fails (callers map
 * that to a 500/404). The legacy /api/v1/labels/[id] route keeps its own inline
 * copy — this helper is intentionally NOT wired into it to avoid touching a
 * working prod route.
 */
export async function signedLabelPdfUrl(pdfPath: string): Promise<string | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'labels';
  if (!supabaseUrl || !supabaseKey) return null;

  const res = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${pdfPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { signedURL?: string };
  return data.signedURL ? `${supabaseUrl}/storage/v1${data.signedURL}` : null;
}
