import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';
import { createClient } from '@supabase/supabase-js';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedTenant();
    if (!auth) return apiError('No autorizado', 401);

    const { id } = await context.params;

    const label = await db.label.findFirst({
      where: { id, tenantId: auth.tenantId },
    });

    if (!label) return apiError('Etiqueta no encontrada', 404);

    if (!label.pdfPath) {
      return apiError('PDF no disponible para esta etiqueta', 404);
    }

    // Direct Supabase call with detailed error reporting
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'labels';

    if (!supabaseUrl || !supabaseKey) {
      console.error('Missing Supabase env vars', { hasUrl: !!supabaseUrl, hasKey: !!supabaseKey });
      return apiError(`Supabase config missing: URL=${!!supabaseUrl}, KEY=${!!supabaseKey}`, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(label.pdfPath, 3600);

    if (error) {
      console.error('Supabase signed URL error:', error.message, { bucket, path: label.pdfPath });
      return apiError(`PDF error: ${error.message} (bucket=${bucket}, path=${label.pdfPath})`, 500);
    }

    if (!data?.signedUrl) {
      return apiError('Supabase returned empty signed URL', 500);
    }

    // Redirect to the signed Supabase URL so the browser opens/downloads the PDF
    return NextResponse.redirect(data.signedUrl);
  } catch (err) {
    console.error('Labels API error:', err);
    return apiError(`Error interno: ${(err as Error).message}`, 500);
  }
}
