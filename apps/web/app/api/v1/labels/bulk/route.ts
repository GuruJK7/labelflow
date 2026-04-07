import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(50),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthenticatedTenant();
    if (!auth) return apiError('No autorizado', 401);

    const body = await req.json();
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(`Datos invalidos: ${parsed.error.message}`, 400);
    }

    const { ids } = parsed.data;

    // Fetch all labels belonging to this tenant with PDFs
    const labels = await db.label.findMany({
      where: {
        id: { in: ids },
        tenantId: auth.tenantId,
        pdfPath: { not: null },
      },
      select: { id: true, pdfPath: true, shopifyOrderName: true },
    });

    if (labels.length === 0) {
      return apiError('No se encontraron etiquetas con PDF', 404);
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'labels';

    if (!supabaseUrl || !supabaseKey) {
      return apiError('Supabase config missing', 500);
    }

    // Fetch all PDFs in parallel
    const fetchResults = await Promise.allSettled(
      labels.map(async (label) => {
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
          throw new Error(`Sign failed for ${label.shopifyOrderName}: ${signRes.status}`);
        }

        const signData = await signRes.json();
        const signedUrl = signData.signedURL
          ? `${supabaseUrl}/storage/v1${signData.signedURL}`
          : null;

        if (!signedUrl) {
          throw new Error(`No signed URL for ${label.shopifyOrderName}`);
        }

        const pdfRes = await fetch(signedUrl);
        if (!pdfRes.ok) {
          throw new Error(`PDF fetch failed for ${label.shopifyOrderName}: ${pdfRes.status}`);
        }

        return await pdfRes.arrayBuffer();
      })
    );

    // Collect successful PDFs
    const pdfBuffers: ArrayBuffer[] = [];
    let failedCount = 0;

    for (const result of fetchResults) {
      if (result.status === 'fulfilled') {
        pdfBuffers.push(result.value);
      } else {
        failedCount++;
        console.error('Bulk PDF fetch error:', result.reason);
      }
    }

    if (pdfBuffers.length === 0) {
      return apiError('No se pudo descargar ninguno de los PDFs', 502);
    }

    // Merge all PDFs into one document
    const merged = await PDFDocument.create();

    for (const buffer of pdfBuffers) {
      try {
        const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const pages = await merged.copyPages(source, source.getPageIndices());
        for (const page of pages) {
          merged.addPage(page);
        }
      } catch (err) {
        failedCount++;
        console.error('PDF merge error:', err);
      }
    }

    if (merged.getPageCount() === 0) {
      return apiError('No se pudo procesar ninguno de los PDFs', 502);
    }

    const mergedBytes = await merged.save();

    // Determine disposition based on query param
    const download = req.nextUrl.searchParams.get('download') === 'true';
    const disposition = download
      ? 'attachment; filename="etiquetas.pdf"'
      : 'inline; filename="etiquetas.pdf"';

    const headers: Record<string, string> = {
      'Content-Type': 'application/pdf',
      'Content-Disposition': disposition,
      'X-Labels-Total': String(labels.length),
      'X-Labels-Merged': String(merged.getPageCount()),
    };

    if (failedCount > 0) {
      headers['X-Labels-Failed'] = String(failedCount);
    }

    return new NextResponse(Buffer.from(mergedBytes), { status: 200, headers });
  } catch (err) {
    const error = err as Error;
    console.error('Bulk labels error:', error.message);

    if (error.message === 'fetch failed') {
      return apiError(
        'No se pudo conectar a Supabase Storage. El proyecto puede estar pausado.',
        503
      );
    }

    return apiError(`Error: ${error.message}`, 500);
  }
}
