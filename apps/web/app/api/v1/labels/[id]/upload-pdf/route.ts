import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { uploadPdf } from '@/lib/supabase';
import { deductCreditsAndStamp } from '@/lib/credits';

/**
 * POST /api/v1/labels/[id]/upload-pdf
 *
 * Operator-initiated rescue path for the bug-#2 case from the 2026-04-29
 * billing fairness audit: DAC successfully generated a real guía, the
 * customer was fulfilled in Shopify and notified, but the worker's PDF
 * upload to Supabase failed (after 2 in-job retries). The Label was parked
 * with status NEEDS_REVIEW and errorMessage explaining the situation, and
 * the tenant was NOT charged a credit for that order.
 *
 * This endpoint lets the operator finish the job manually:
 *   1. Re-download the label from DAC by hand (or scan a printed copy).
 *   2. Upload it here as multipart/form-data with field name "pdf".
 *   3. Endpoint stores it at the canonical path, flips Label.status to
 *      COMPLETED, and bills the tenant exactly 1 credit via the same
 *      drain helper the worker uses.
 *
 * Eligibility: label must belong to the authenticated tenant, be in status
 * NEEDS_REVIEW, and have a real dacGuia (not a "PENDING-" placeholder —
 * those orders need a different rescue: the operator must look up the real
 * guía in DAC historial, not just upload a PDF). For PENDING- labels we
 * return 422 with a message pointing them at the redo flow.
 *
 * File limits: 10 MB max (Supabase free tier accepts up to 50 MB but we
 * cap below the Vercel function payload ceiling). Content-Type must be
 * application/pdf.
 *
 * Idempotency: if the same label already has a pdfPath when this is called,
 * we overwrite (Supabase upload uses upsert: true). We bill the credit only
 * if the previous status was NEEDS_REVIEW — calling this on an already-
 * COMPLETED label is treated as a re-upload (storage replaced, no second
 * charge). That's deliberate so a double-click on the operator button
 * doesn't double-bill.
 */

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { id } = await context.params;
  const tenantId = auth.tenantId;

  const label = await db.label.findFirst({
    where: { id, tenantId },
    select: {
      id: true,
      shopifyOrderName: true,
      dacGuia: true,
      status: true,
      pdfPath: true,
    },
  });

  if (!label) return apiError('Etiqueta no encontrada', 404);

  if (!label.dacGuia || label.dacGuia.startsWith('PENDING-')) {
    return apiError(
      'Esta etiqueta no tiene un número de guía DAC real (queda como "PENDING-…"). Buscá la guía en DAC historial y usá la acción "Reenviar" para volver a procesarla, en lugar de subir un PDF acá.',
      422,
    );
  }

  if (label.status !== 'NEEDS_REVIEW' && label.status !== 'CREATED') {
    return apiError(
      `Esta etiqueta está en estado "${label.status}". El upload manual solo aplica a etiquetas en revisión (NEEDS_REVIEW) o creadas pero sin PDF (CREATED). Si querés reemplazar un PDF ya completado, usá "Reenviar" para volver a procesar la orden.`,
      422,
    );
  }

  // Parse the multipart form
  let pdfBuffer: Buffer;
  try {
    const form = await request.formData();
    const fileEntry = form.get('pdf');
    if (!(fileEntry instanceof File)) {
      return apiError('Falta el campo "pdf" con el archivo PDF.', 400);
    }
    if (fileEntry.type && fileEntry.type !== 'application/pdf') {
      return apiError(
        `El archivo debe ser application/pdf (recibido: ${fileEntry.type}).`,
        415,
      );
    }
    if (fileEntry.size > MAX_PDF_BYTES) {
      return apiError(
        `El PDF supera el límite de 10 MB (subiste ${(fileEntry.size / 1024 / 1024).toFixed(1)} MB).`,
        413,
      );
    }
    if (fileEntry.size < 100) {
      // Anything under 100 bytes is definitely not a real PDF.
      return apiError('El archivo está vacío o es demasiado chico.', 400);
    }
    const arrayBuffer = await fileEntry.arrayBuffer();
    pdfBuffer = Buffer.from(arrayBuffer);
    // Quick magic-byte sanity check — PDF files start with "%PDF-".
    if (pdfBuffer.subarray(0, 5).toString('utf-8') !== '%PDF-') {
      return apiError(
        'El archivo no parece ser un PDF válido (no empieza con "%PDF-").',
        400,
      );
    }
  } catch (err) {
    return apiError(
      `No se pudo leer el archivo: ${(err as Error).message}`,
      400,
    );
  }

  // Path mirrors the worker's canonical scheme:
  // {tenantId}/{YYYY-MM-DD UY-local}/{labelId}.pdf
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Montevideo',
  }); // YYYY-MM-DD
  const storagePath = `${tenantId}/${today}/${label.id}.pdf`;

  const upload = await uploadPdf(storagePath, pdfBuffer);
  if (upload.error) {
    return apiError(`Falló la subida al storage: ${upload.error}`, 502);
  }

  const wasNeedsReview = label.status === 'NEEDS_REVIEW';

  // Single transaction: flip the label to COMPLETED with the new path, and
  // log the operator action for audit. Credit decrement happens AFTER the
  // transaction so a failure to bill doesn't roll back the upload (the PDF
  // is already on S3 and the customer is fulfilled — refusing to flip the
  // label would be the worse outcome).
  await db.$transaction(async (tx) => {
    await tx.label.update({
      where: { id: label.id },
      data: {
        status: 'COMPLETED',
        pdfPath: upload.path,
        errorMessage: null,
      },
    });
    await tx.runLog.create({
      data: {
        tenantId,
        jobId: null,
        level: 'INFO',
        message: 'label-manual-pdf-upload',
        meta: {
          labelId: label.id,
          shopifyOrderName: label.shopifyOrderName,
          previousStatus: label.status,
          previousPdfPath: label.pdfPath,
          newPdfPath: upload.path,
          billed: wasNeedsReview,
          triggeredBy: 'dashboard-upload-pdf',
        },
      },
    });
  });

  // Bill exactly 1 credit, but only if the label was previously NEEDS_REVIEW
  // (i.e. it was specifically un-billed by the worker's billing-fairness
  // guard). A re-upload on an already-COMPLETED label or one that was just
  // CREATED-without-PDF doesn't get billed again here — that path is
  // already accounted for by whatever ran first.
  if (wasNeedsReview) {
    await deductCreditsAndStamp(tenantId, 1);
  }

  return apiSuccess({
    labelId: label.id,
    orderName: label.shopifyOrderName,
    pdfPath: upload.path,
    billed: wasNeedsReview,
    message: wasNeedsReview
      ? 'PDF subido. Etiqueta marcada como completada y crédito descontado.'
      : 'PDF subido. Etiqueta actualizada (sin cobro adicional — ya estaba contabilizada).',
  });
}
