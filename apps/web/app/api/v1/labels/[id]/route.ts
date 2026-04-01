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

    // Use REST API directly instead of SDK to avoid fetch issues on Vercel
    const signUrl = `${supabaseUrl}/storage/v1/object/sign/${bucket}/${label.pdfPath}`;
    const signRes = await fetch(signUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    });

    if (!signRes.ok) {
      const errText = await signRes.text();
      console.error('Supabase sign error:', errText, { status: signRes.status, bucket, path: label.pdfPath });
      return apiError(`PDF sign error (${signRes.status}): ${errText}`, 500);
    }

    const signData = await signRes.json();
    const signedUrl = signData.signedURL
      ? `${supabaseUrl}/storage/v1${signData.signedURL}`
      : null;

    if (!signedUrl) {
      return apiError(`No signed URL returned: ${JSON.stringify(signData)}`, 500);
    }

    return NextResponse.redirect(signedUrl);
  } catch (err) {
    console.error('Labels API error:', err);
    return apiError(`Error: ${(err as Error).message}`, 500);
  }
}
