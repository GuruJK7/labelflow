import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';

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

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'labels';

    if (!supabaseUrl || !supabaseKey) {
      return apiError('Supabase config missing', 500);
    }

    // Download the PDF directly from Supabase and stream it to the client.
    // Using the authenticated object download endpoint (no signing needed).
    const downloadUrl = `${supabaseUrl}/storage/v1/object/authenticated/${bucket}/${label.pdfPath}`;

    const pdfRes = await fetch(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (!pdfRes.ok) {
      const errText = await pdfRes.text();
      console.error('Supabase download error:', errText, {
        status: pdfRes.status,
        bucket,
        path: label.pdfPath,
        url: downloadUrl,
      });
      return apiError(`PDF download error (${pdfRes.status}): ${errText}`, 500);
    }

    const pdfBuffer = await pdfRes.arrayBuffer();
    const fileName = `etiqueta-${label.shopifyOrderName || label.id}.pdf`;

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${fileName}"`,
        'Content-Length': String(pdfBuffer.byteLength),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (err) {
    const error = err as Error;
    console.error('Labels API error:', error.message, error.cause ?? '', error.stack ?? '');
    return apiError(`Error: ${error.message}`, 500);
  }
}
