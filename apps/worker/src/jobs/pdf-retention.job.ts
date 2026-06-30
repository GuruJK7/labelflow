/**
 * PDF retention job: deletes label PDFs older than the retention window from
 * Supabase Storage to cap storage cost — WITHOUT touching the Label rows.
 *
 * Why this is safe for billing: the permanent "envíos facturados" counter in
 * the client portal counts Label ROWS (status CREATED/COMPLETED), never PDFs.
 * This job only removes the stored file and nulls pdfPath/pdfUrl, so the row —
 * with its guía, order name, status and dates — lives forever and the counter
 * never goes down. After 15 days the shipment is already dispatched, so the
 * (now deleted) printable PDF is no longer needed.
 *
 * Idempotent + crash-safe:
 *   - Only labels with pdfPath != null AND createdAt < cutoff are touched.
 *   - We delete the Storage object FIRST, then null pdfPath. If the DB update
 *     fails, the next run re-removes (a no-op on Supabase) and nulls again. If
 *     the Storage remove fails we leave pdfPath set and retry next run — we
 *     never leave a row advertising a PDF that's already gone.
 *   - Processed in batches; each row drops out of the next query as soon as its
 *     pdfPath is nulled, so the loop self-terminates. A per-run batch cap keeps
 *     a large first-run backlog from hogging one tick — the remainder is picked
 *     up on the next daily run (or next boot).
 */
import { db } from '../db';
import logger from '../logger';
import { removeLabelPdfs } from '../storage/upload';

/** Days a label PDF is kept before deletion. Override with PDF_RETENTION_DAYS. */
const RETENTION_DAYS = (() => {
  const n = Number(process.env.PDF_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
})();

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // run once a day
const BATCH_SIZE = 200; // rows (and Storage keys) per batch — well under the 1000 cap
const MAX_BATCHES_PER_RUN = 60; // backstop: ≤12k PDFs/run; remainder next run

export async function runPdfRetention(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;
  let batches = 0;

  try {
    for (; batches < MAX_BATCHES_PER_RUN; ) {
      const rows = await db.label.findMany({
        where: { pdfPath: { not: null }, createdAt: { lt: cutoff } },
        select: { id: true, pdfPath: true },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });
      if (rows.length === 0) break;

      const paths = rows
        .map((r) => r.pdfPath)
        .filter((p): p is string => !!p);

      // 1) Delete the files. A non-null error means the whole remove() call
      //    failed — leave pdfPath set and stop (retry next run), never null a
      //    row whose object we couldn't remove. A no-error response means every
      //    requested key is now absent (deleted now, or already gone), so the
      //    rows are safe to clear. `deleted` is the count actually removed.
      const { deleted, error } = await removeLabelPdfs(paths);
      if (error) {
        logger.error(
          { error, batch: batches, attempted: paths.length },
          '[PdfRetention] Storage remove failed — leaving rows for next run',
        );
        break;
      }

      // 2) Null pdfPath/pdfUrl on exactly the rows whose objects we just cleared.
      await db.label.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { pdfPath: null, pdfUrl: null },
      });

      totalDeleted += deleted;
      batches += 1;
    }

    if (batches >= MAX_BATCHES_PER_RUN) {
      logger.info(
        { totalDeleted },
        '[PdfRetention] Hit per-run batch cap; remainder handled next run',
      );
    }
    if (totalDeleted > 0) {
      logger.info(
        { totalDeleted, retentionDays: RETENTION_DAYS },
        '[PdfRetention] Deleted expired label PDFs (rows kept for billing)',
      );
    }
  } catch (err) {
    logger.error(
      { error: (err as Error).message },
      '[PdfRetention] Run failed',
    );
  }
}

export function startPdfRetentionLoop(): void {
  setInterval(() => {
    runPdfRetention().catch((err) =>
      logger.error(
        { error: (err as Error).message },
        '[PdfRetention] Loop iteration failed',
      ),
    );
  }, RETENTION_INTERVAL_MS);
  logger.info(
    { intervalMs: RETENTION_INTERVAL_MS, retentionDays: RETENTION_DAYS },
    '[PdfRetention] Loop started',
  );
}
