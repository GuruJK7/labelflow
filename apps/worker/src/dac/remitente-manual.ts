/**
 * Helpers for the REMITENTE (sender-paid) manual handoff.
 *
 * 2026-04-22 — we removed the auto-pay-with-card flow (PCI concern +
 * Plexo session hangs). For any order classified as REMITENTE we now:
 *
 *   1) flip the Label to NEEDS_REVIEW with an errorMessage prompt, and
 *   2) drop a Spanish note on the Shopify order telling the operator
 *      to load the shipment manually in DAC.
 *
 * The note text and its dedup prefix are centralized here so the two
 * call sites (process-orders.job.ts and agent-bulk-upload.job.ts)
 * stay in sync and so the prefix used for idempotency checks cannot
 * drift from the actual note body.
 */

/**
 * Build the Spanish operator note written to the Shopify order.
 *
 * The exact text is part of the contract — downstream code uses the
 * first {@link REMITENTE_NOTE_DEDUP_PREFIX_LEN} chars to detect a
 * prior note on the same order and skip re-writing (dedup on repeated
 * reprocess cycles).
 */
export function buildRemitenteShopifyNote(totalUyu: number): string {
  const safeTotal = Number.isFinite(totalUyu) && totalUyu > 0 ? totalUyu : 0;
  return (
    `LabelFlow: este envío debe pagarlo el remitente (total $${safeTotal.toFixed(2)} UYU). ` +
    `No se procesa automáticamente en DAC — cargalo a mano en DAC y marcá como pagado. ` +
    `Cuando lo marqués como "Fulfilled" en Shopify el worker lo saca de la cola.`
  );
}

/**
 * Number of leading characters from the note body used as a dedup
 * prefix. 80 chars is wide enough to uniquely identify a LabelFlow
 * REMITENTE note even when the order total differs, and narrow
 * enough to survive minor copy edits to the tail of the message.
 */
export const REMITENTE_NOTE_DEDUP_PREFIX_LEN = 80;

/**
 * Short errorMessage stored on the Label row so the dashboard and
 * reprocess-path recognize it as an intentional manual handoff
 * rather than an actual failure.
 */
export const REMITENTE_LABEL_MESSAGE =
  'Envío REMITENTE — cargar manualmente en DAC';
