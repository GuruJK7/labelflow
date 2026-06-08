import type { Page } from 'playwright';
import type { AxiosInstance } from 'axios';
import fs from 'fs';
import { db } from '../db';
import type { StepLogger } from '../logger';
import { downloadLabel } from './label';
import { uploadLabelPdf } from '../storage/upload';
import { fulfillOrderWithTracking, ShopifyAlreadyFulfilledError } from '../shopify/fulfillment';
import { markOrderProcessed } from '../shopify/orders';
import { isStep3GeoTenantEnabled } from './geocode-fallback';

const STEP = 'finalize-recovered';

export interface FinalizeRecoveredResult {
  scanned: number;
  finalized: number;
  failed: number;
}

/**
 * Finalize "recovered orphan" labels that are stuck with a guía but no PDF.
 *
 * Background (measured 2026-06-08): when DAC silently rejects a form the order
 * can still have minted a guía. orphan-reconcile (dac/orphan-reconcile.ts) finds
 * that guía in the DAC historial, writes it onto the Label, flips
 * status=FAILED, and leaves a "next cycle will download PDF + fulfill" note. But
 * the PDF download + Shopify fulfill only run when the ORDER is re-fetched and
 * re-processed by the main loop (process-orders.job.ts, the prior-label-with-
 * real-guia branch ~L811). Orders that are not re-reached — buried past the
 * per-run cap, or otherwise not re-fetched — stay FAILED with a real guía but no
 * pdfPath. The client portal then shows "Sin PDF", the merchant cannot print,
 * and the parcel never ships. 13 such labels were found across 4 stores, 2-7
 * days old.
 *
 * This sweep closes that gap. For every FAILED Label that already carries a real
 * (non-PENDING) guía but has no pdfPath, it downloads the PDF for the EXISTING
 * guía via downloadLabel — which navigates the historial/pegote, it does NOT
 * submit a new DAC form, so it can never mint a duplicate — uploads it, and
 * marks the Label COMPLETED. Once a Label is COMPLETED with a real guía,
 * partitionByCompletedLabels (process-orders.job.ts ~L256) skips that order on
 * every future run, so there is provably no path to a duplicate shipment.
 *
 * Shopify fulfill + tag are attempted best-effort afterwards (mirrors the
 * reuse-guia branch) and can never fail the finalization — the shipment is
 * already recoverable from the portal once the PDF exists.
 *
 * Safety contract:
 *  - Gated by DAC_FINALIZE_RECOVERED_GUIA via the shared '*'/comma-list gate.
 *    Default OFF -> the function returns immediately (no DB reads, no DAC nav),
 *    so the deploy is byte-identical until a tenant is opted in.
 *  - Reuses only already-tested helpers (downloadLabel, uploadLabelPdf,
 *    fulfillOrderWithTracking, markOrderProcessed). It NEVER touches the DAC
 *    form-fill automation that mints guías.
 *  - Best-effort per label: any download/upload/Shopify failure leaves that
 *    Label exactly as it was (still FAILED) and the function never throws.
 */
export async function finalizeRecoveredGuiaLabels(opts: {
  page: Page;
  tenantId: string;
  slog: StepLogger;
  tmpDir: string;
  dacUsername: string;
  dacPassword: string;
  shopifyClient: AxiosInstance;
  enabledTenantsEnv: string | undefined;
  maxToFinalize?: number;
}): Promise<FinalizeRecoveredResult> {
  const { page, tenantId, slog, tmpDir, dacUsername, dacPassword, shopifyClient, enabledTenantsEnv } = opts;
  const result: FinalizeRecoveredResult = { scanned: 0, finalized: 0, failed: 0 };

  // Gate: OFF by default. Until a tenant is listed (or '*'), this is a no-op.
  if (!isStep3GeoTenantEnabled(enabledTenantsEnv, tenantId)) return result;

  // The stuck "recovered orphan" set: FAILED + real guía + no PDF.
  const stuck = await db.label.findMany({
    where: { tenantId, status: 'FAILED', dacGuia: { not: null }, pdfPath: null },
    select: { id: true, shopifyOrderId: true, shopifyOrderName: true, dacGuia: true },
    orderBy: { createdAt: 'asc' },
    take: opts.maxToFinalize ?? 25,
  });
  const targets = stuck.filter(
    (l): l is (typeof stuck)[number] & { dacGuia: string } =>
      typeof l.dacGuia === 'string' && !l.dacGuia.startsWith('PENDING-'),
  );
  result.scanned = targets.length;
  if (targets.length === 0) return result;

  slog.info(
    STEP,
    `Found ${targets.length} FAILED label(s) with a recovered guía but no PDF — finalizing (download the existing guía's PDF, no re-submit).`,
  );

  for (const label of targets) {
    const guia = label.dacGuia;
    const tag = label.shopifyOrderName ?? label.shopifyOrderId;
    try {
      // 1) Download the PDF for the EXISTING guía. No DAC form submit -> no dup.
      let localPath: string | null = null;
      try {
        localPath = await downloadLabel(page, guia, tmpDir, dacUsername, dacPassword);
      } catch (dlErr) {
        slog.warn(STEP, `[${tag}] PDF download threw for guía ${guia} — leaving FAILED (no change): ${(dlErr as Error).message}`);
        result.failed++;
        continue;
      }
      if (!localPath || !fs.existsSync(localPath)) {
        slog.warn(STEP, `[${tag}] No PDF available yet for guía ${guia} — leaving FAILED (no change).`);
        result.failed++;
        continue;
      }

      // 2) Upload to storage.
      const pdfBuffer = fs.readFileSync(localPath);
      const upload = await uploadLabelPdf(tenantId, label.id, pdfBuffer);
      try { fs.unlinkSync(localPath); } catch { /* best-effort cleanup */ }
      if (upload.error) {
        slog.warn(STEP, `[${tag}] PDF upload failed for guía ${guia}: ${upload.error} — leaving FAILED (no change).`);
        result.failed++;
        continue;
      }

      // 3) Mark COMPLETED. From here partitionByCompletedLabels skips the order
      //    on every future run -> no re-submission -> no duplicate guía.
      await db.label.update({
        where: { id: label.id },
        data: { pdfPath: upload.path, status: 'COMPLETED', errorMessage: null },
      });
      result.finalized++;
      slog.success(STEP, `[${tag}] Finalized: guía ${guia} -> PDF uploaded, status COMPLETED. The client portal can now print it.`);

      // 4) Best-effort Shopify fulfill + tag (mirrors the reuse-guia branch).
      //    Never fatal: the parcel is already printable/shippable via the portal.
      const orderIdNum = Number(label.shopifyOrderId);
      if (Number.isFinite(orderIdNum)) {
        try {
          await fulfillOrderWithTracking(shopifyClient, orderIdNum, guia);
          slog.info(STEP, `[${tag}] Shopify fulfilled — tracking sent to customer.`);
        } catch (fErr) {
          if (fErr instanceof ShopifyAlreadyFulfilledError) {
            slog.info(STEP, `[${tag}] Already fulfilled in Shopify — skipping (benign).`);
          } else {
            slog.warn(STEP, `[${tag}] Shopify fulfill failed (non-fatal): ${(fErr as Error).message}`);
          }
        }
        try {
          await markOrderProcessed(shopifyClient, orderIdNum, guia);
        } catch (tagErr) {
          slog.warn(STEP, `[${tag}] Shopify tag failed (non-fatal): ${(tagErr as Error).message}`);
        }
      }
    } catch (err) {
      slog.warn(STEP, `[${tag}] Finalize threw for guía ${guia} (non-fatal): ${(err as Error).message}`);
      result.failed++;
    }
  }

  slog.info(
    STEP,
    `Finalize sweep done: ${result.finalized} finalized, ${result.failed} left FAILED, ${result.scanned} scanned.`,
  );
  return result;
}
