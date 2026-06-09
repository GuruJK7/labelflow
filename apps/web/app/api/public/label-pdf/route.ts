/**
 * GET /api/public/label-pdf?id=<labelId>&token=<clientToken>
 *
 * Token-gated PDF download for the client portal (see lib/client-view.ts).
 * Mirrors the signing flow of /api/v1/labels/[id] (1-hour Supabase signed
 * URL) but authorizes with the portal token + tenant allow-list instead of a
 * NextAuth session, so a logged-out client can fetch only the PDFs of the two
 * allow-listed stores. A label outside the allow-list (or a bad/absent token)
 * returns the same 404/401 as a non-existent id — existence never leaks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import {
  resolveClientToken,
  getClientViewLabelPdfPath,
} from '@/lib/client-view';

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token');
    const tenantIds = await resolveClientToken(token);
    if (!tenantIds) return apiError('No autorizado', 401);

    const id = req.nextUrl.searchParams.get('id');
    if (!id) return apiError('id requerido', 400);

    const pdfPath = await getClientViewLabelPdfPath(id, tenantIds);
    if (!pdfPath) return apiError('Etiqueta no encontrada', 404);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'labels';

    if (!supabaseUrl || !supabaseKey) {
      return apiError('Supabase config missing', 500);
    }

    const signUrl = `${supabaseUrl}/storage/v1/object/sign/${bucket}/${pdfPath}`;
    const signRes = await fetch(signUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    });

    if (!signRes.ok) {
      const errText = await signRes.text();
      console.error('Public PDF sign error:', errText, {
        status: signRes.status,
      });
      return apiError(`PDF sign error (${signRes.status})`, 500);
    }

    const signData = await signRes.json();
    const signedUrl = signData.signedURL
      ? `${supabaseUrl}/storage/v1${signData.signedURL}`
      : null;

    if (!signedUrl) return apiError('No signed URL returned', 500);

    return NextResponse.redirect(signedUrl);
  } catch (err) {
    const error = err as Error;
    if (error.message === 'fetch failed') {
      return apiError(
        'No se pudo conectar a Supabase Storage. Intentá de nuevo en unos minutos.',
        503,
      );
    }
    return apiError(`Error: ${error.message}`, 500);
  }
}
