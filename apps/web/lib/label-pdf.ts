/**
 * Vida de una URL firmada de PDF: 1 hora, el mismo valor que ya usaban inline
 * /api/public/label-pdf, /api/public/label-pdf/bulk y /api/v1/labels/[id].
 *
 * Se exporta para que quien PUBLIQUE la URL (el export al WMS manda `expira_en`
 * en el `meta`) diga la misma vida que la firma real. Si esto y el `expiresIn`
 * de abajo se separan, DEPO recibe una fecha de vencimiento mentirosa y se
 * entera cuando el PDF ya no abre. Por eso el número vive UNA sola vez.
 */
export const LABEL_PDF_SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Create a short-lived Supabase signed URL for a label PDF in the `labels`
 * bucket. Shared by the multi-store control PDF route and by the WMS export
 * (lib/wms-export-pdf.ts). Returns the signed URL string, or null if storage is
 * not configured / signing fails (callers map that to a 500/404, or to a null
 * `pdf_url` in the case of the export). The legacy /api/v1/labels/[id] route
 * keeps its own inline copy — this helper is intentionally NOT wired into it to
 * avoid touching a working prod route.
 */
export async function signedLabelPdfUrl(pdfPath: string): Promise<string | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'labels';
  if (!supabaseUrl || !supabaseKey) return null;

  const res = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${pdfPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: LABEL_PDF_SIGNED_URL_TTL_SECONDS }),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { signedURL?: string };
  return data.signedURL ? `${supabaseUrl}/storage/v1${data.signedURL}` : null;
}
