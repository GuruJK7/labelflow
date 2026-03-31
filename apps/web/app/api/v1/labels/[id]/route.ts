import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
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

    let pdfUrl: string | null = null;
    if (label.pdfPath) {
      pdfUrl = await getSignedUrl(label.pdfPath);
    }

    return apiSuccess({
      ...label,
      pdfUrl,
    });
  } catch (err) {
    console.error('Labels API error:', err);
    return apiError('Error interno', 500);
  }
}
