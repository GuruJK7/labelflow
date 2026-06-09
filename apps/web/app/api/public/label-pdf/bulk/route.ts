/**
 * POST /api/public/label-pdf/bulk?token=<clientToken>[&download=true]
 * Body: { ids: string[] }
 *
 * Token-gated BULK PDF download for the client portal (see lib/client-view.ts).
 * The login-less counterpart of /api/v1/labels/bulk: instead of a NextAuth
 * session it authorizes with the portal token + tenant allow-list, then fetches
 * every requested label PDF from Supabase Storage and merges them into a single
 * document so the client can print a whole day (or a hand-picked set) with one
 * print dialog. Ids outside the allow-list are silently dropped — existence
 * never leaks. With ?download=true the merged file downloads instead of opening
 * inline for printing.
 *
 * Privacy posture is unchanged: this returns exactly the PDFs the client can
 * already fetch one-by-one via /api/public/label-pdf, just stitched together.
 */

import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { apiError } from '@/lib/api-utils';
import {
  resolveClientToken,
  getClientViewLabelPdfPaths,
} from '@/lib/client-view';

// Merging many networked PDFs can take longer than the 10s Hobby default.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

// How many Supabase fetches to run at once. Caps fan-out so a big "print the
// whole day" batch never opens 200 sockets at the same time.
const FETCH_CONCURRENCY = 10;

/** Order-preserving, concurrency-limited map with per-item settle semantics. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export async function POST(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token');
    const tenantIds = await resolveClientToken(token);
    if (!tenantIds) return apiError('No autorizado', 401);

    const body = await req.json().catch(() => null);
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) {
      return apiError('Datos invalidos', 400);
    }

    const targets = await getClientViewLabelPdfPaths(parsed.data.ids, tenantIds);
    if (targets.length === 0) {
      return apiError('No se encontraron etiquetas con PDF', 404);
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'labels';

    if (!supabaseUrl || !supabaseKey) {
      return apiError('Supabase config missing', 500);
    }

    async function fetchPdf(pdfPath: string): Promise<ArrayBuffer> {
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
        throw new Error(`sign failed (${signRes.status})`);
      }
      const signData = await signRes.json();
      const signedUrl = signData.signedURL
        ? `${supabaseUrl}/storage/v1${signData.signedURL}`
        : null;
      if (!signedUrl) throw new Error('no signed url');
      const pdfRes = await fetch(signedUrl);
      if (!pdfRes.ok) throw new Error(`fetch failed (${pdfRes.status})`);
      return pdfRes.arrayBuffer();
    }

    const fetchResults = await mapPool(
      targets,
      FETCH_CONCURRENCY,
      (t) => fetchPdf(t.pdfPath),
    );

    let failedCount = 0;
    const merged = await PDFDocument.create();

    for (const result of fetchResults) {
      if (result.status !== 'fulfilled') {
        failedCount++;
        console.error('Portal bulk PDF fetch error:', result.reason);
        continue;
      }
      try {
        const source = await PDFDocument.load(result.value, {
          ignoreEncryption: true,
        });
        const pages = await merged.copyPages(source, source.getPageIndices());
        for (const page of pages) merged.addPage(page);
      } catch (err) {
        failedCount++;
        console.error('Portal bulk PDF merge error:', err);
      }
    }

    if (merged.getPageCount() === 0) {
      return apiError('No se pudo procesar ninguno de los PDFs', 502);
    }

    const mergedBytes = await merged.save();

    const download = req.nextUrl.searchParams.get('download') === 'true';
    const disposition = download
      ? 'attachment; filename="etiquetas.pdf"'
      : 'inline; filename="etiquetas.pdf"';

    const headers: Record<string, string> = {
      'Content-Type': 'application/pdf',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
      'X-Labels-Total': String(targets.length),
      'X-Labels-Merged': String(merged.getPageCount()),
    };
    if (failedCount > 0) headers['X-Labels-Failed'] = String(failedCount);

    return new NextResponse(Buffer.from(mergedBytes), { status: 200, headers });
  } catch (err) {
    const error = err as Error;
    console.error('Portal bulk labels error:', error.message);
    if (error.message === 'fetch failed') {
      return apiError(
        'No se pudo conectar a Supabase Storage. Intentá de nuevo en unos minutos.',
        503,
      );
    }
    return apiError(`Error: ${error.message}`, 500);
  }
}
