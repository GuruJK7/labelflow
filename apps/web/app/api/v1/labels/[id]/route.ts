import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';
import { getSignedUrl } from '@/lib/supabase';

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

    const pdfUrl = await getSignedUrl(label.pdfPath);

    if (!pdfUrl) {
      return apiError('No se pudo generar URL del PDF', 500);
    }

    // Redirect to the signed Supabase URL so the browser opens/downloads the PDF
    return NextResponse.redirect(pdfUrl);
  } catch (err) {
    console.error('Labels API error:', err);
    return apiError('Error interno', 500);
  }
}
