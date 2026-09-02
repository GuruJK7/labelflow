/**
 * GET /api/v1/control/labels/[id]/pdf
 *
 * Redirects to a short-lived Supabase signed URL for an owned label's PDF.
 * Cross-store version of /api/v1/labels/[id]: ownership is checked by userId
 * (via the label's tenant relation), so the "Imprimir" link works for ANY of
 * the user's stores from the control dashboard, not just the active one. For
 * an admin, any active tenant's label too (lib/control-scope).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError } from '@/lib/api-utils';
import { getControlActor, controlTenantWhere } from '@/lib/control-scope';
import { signedLabelPdfUrl } from '@/lib/label-pdf';

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await getControlActor();
  if (!actor) return apiError('No autorizado', 401);

  const { id } = await context.params;

  // Alcance: the label's tenant must be reachable by the actor (own, or any
  // active tenant for an admin).
  const label = await db.label.findFirst({
    where: { id, tenant: controlTenantWhere(actor) },
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
