/**
 * GET /api/v1/control/labels/[id]/pdf
 *
 * Redirects to a short-lived Supabase signed URL for an owned label's PDF.
 * Cross-store version of /api/v1/labels/[id]: ownership is checked by userId
 * (via the label's tenant relation), so the "Imprimir" link works for ANY of
 * the user's stores from the control dashboard, not just the active one.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError } from '@/lib/api-utils';
import { signedLabelPdfUrl } from '@/lib/label-pdf';

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  const { id } = await context.params;

  // Ownership: the label's tenant must belong to the user.
  const label = await db.label.findFirst({
    where: { id, tenant: { userId: auth.userId } },
    select: { pdfPath: true },
  });
  if (!label) return apiError('Etiqueta no encontrada', 404);
  if (!label.pdfPath) return apiError('PDF no disponible para esta etiqueta', 404);

  try {
    const url = await signedLabelPdfUrl(label.pdfPath);
    if (!url) return apiError('No se pudo generar el PDF', 500);
    return NextResponse.redirect(url);
  } catch {
    return apiError('No se pudo conectar a Supabase Storage. Intenta de nuevo.', 503);
  }
}
