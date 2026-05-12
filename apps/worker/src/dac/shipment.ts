import crypto from 'crypto';
import { Page } from 'playwright';
import { Prisma } from '@prisma/client';
import { ShopifyOrder } from '../shopify/types';
import { DacShipmentResult } from './types';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import { DAC_STEPS } from './steps';
import { createStepLogger, StepLogger } from '../logger';
import logger from '../logger';
import { db } from '../db';
import { getDepartmentForCity, getDepartmentForCityAsync, getBarriosFromZip, getDepartmentFromZip, getBarriosFromStreet, CITY_TO_DEPARTMENT, isAmbiguousCityName, isValidUruguayProvince, correctCityWhenEqualsDepartment, fuzzyMatchCity, splitHyphenatedCityName } from './uruguay-geo';
import { preprocessShopifyAddress } from './address-cleanup';
import { assessAddressFeasibility } from './ai-feasibility';
import { validateAddressConsistency } from './ai-address-validator';
import { inferLastNameFromEmail } from './recipient-name-inference';
import { resolveAddressWithAI, AIResolverResult } from './ai-resolver';
import { handlePaymentFlow, AutoPayConfig, PaymentOutcome } from './payment';

// ---- C-4 (2026-04-21 audit): duplicate-guia defense ----
//
// DAC's Finalizar click is irreversible. If we crash between the click and
// a successful guía extraction, DAC has created a shipment and we have no
// record — a retry would create a second shipment and bill the customer
// twice.
//
// Mitigation:
//   1. `assertNoPriorSubmit` runs BEFORE entering the form. If a
//      PendingShipment row already exists for (tenantId, shopifyOrderId),
//      we refuse to proceed and surface a dedicated error type the caller
//      (process-orders.job.ts) can map to Label.status = NEEDS_REVIEW.
//   2. `markSubmitAttempted` runs RIGHT BEFORE the Finalizar click. Inserts
//      status=PENDING. If two workers race, the unique constraint makes
//      exactly one win; the loser gets the duplicate-submit error.
//   3. `markSubmitResolved` runs AFTER extraction succeeds, flipping
//      status=RESOLVED and storing the real guía for the audit trail.
//   4. reconcile.job.ts step 2 sweeps PENDING rows older than a threshold
//      and marks them ORPHANED — those are the ones that need an operator
//      to manually reconcile against DAC historial.

export class DuplicateSubmitError extends Error {
  readonly isDuplicateSubmit = true as const;
  constructor(
    message: string,
    readonly existingStatus: string,
    readonly existingGuia: string | null,
  ) {
    super(message);
    this.name = 'DuplicateSubmitError';
  }
}

/**
 * Thrown when DAC rejects the shipment form silently — the submit leaves the
 * browser on `/envios/nuevo` with no guía extracted. In practice this almost
 * always means the customer's Shopify address fields (city / address / zip)
 * don't resolve to a valid DAC department+barrio combination — e.g. a city
 * like "Parquizado" (not a real Uruguay locality) or an address1 that's a
 * descriptive phrase rather than a real street+number.
 *
 * Surfacing this as its own error class lets the job layer write a friendly,
 * actionable Spanish note on the Shopify order ("dirección del cliente
 * incompleta o no reconocida — pedir a Noelia la dirección real") and mark
 * the Label as NEEDS_REVIEW (not FAILED) so the operator treats it as
 * "contactar cliente" instead of "retry technical failure".
 *
 * The guard that throws this also deletes the PENDING PendingShipment row
 * (see the DAC-rejected-form branch in createShipment), so once the operator
 * fixes the address in Shopify the next cron tick will reprocess cleanly.
 */
export class DacAddressRejectedError extends Error {
  readonly isDacAddressRejected = true as const;
  /**
   * Raw validation text scraped from the DAC error box (if any), so the
   * Shopify note shown to the operator reflects the ACTUAL reason DAC
   * rejected the form (wrong ZIP, missing barrio, invalid phone, etc.)
   * instead of our catch-all "dirección confusa".
   *
   * Empty string when no error box was visible — falls back to the
   * generic "localidad/barrio no pudo identificarse" wording in the
   * job-level note builder.
   */
  readonly dacErrorText: string;
  /**
   * True when DAC's error box was empty AND the historial-rescue path
   * also failed to find a matching guía. In that ambiguous state the
   * order MIGHT have an orphan guía in DAC (the rescue couldn't see it
   * for timing/pagination reasons) OR DAC genuinely rejected the form
   * silently. Either way, we cannot safely retry — a retry could create
   * a duplicate orphan guía. The PendingShipment row is preserved by
   * the caller in this case so the C-4 duplicate-submit guard parks the
   * order until the operator manually verifies DAC historial.
   *
   * Audit 2026-05-06 — see #11724 Marcela Pascal, #11733 Silvia Aranda,
   * #11746 CLAUDIA GARCIA MENENDEZ for the production cases that
   * motivated this. Some of those retries scanned only 1–5 historial
   * rows on first load, missing real guías that existed in DAC.
   */
  readonly rescueFailed: boolean;
  constructor(
    message: string,
    readonly orderName: string,
    dacErrorText: string = '',
    rescueFailed: boolean = false,
  ) {
    super(message);
    this.name = 'DacAddressRejectedError';
    this.dacErrorText = dacErrorText;
    this.rescueFailed = rescueFailed;
  }
}

/**
 * Best-effort scrape of whatever validation text DAC is showing right
 * now, used when the form silently rejected (URL stayed on /envios/nuevo).
 *
 * DAC does not expose a stable error API. We try several selectors
 * defensively and pick the shortest non-empty one:
 *
 *   - `.validation-summary-errors` / `.field-validation-error`
 *     (standard ASP.NET MVC validation helpers DAC uses)
 *   - `.alert-danger` / `.alert-error` (bootstrap alert boxes)
 *   - any element whose visible text contains "error" or "inválido"
 *
 * Returns an empty string if nothing is visible. Trimmed and capped
 * at 240 chars so it fits inside a Shopify note comfortably.
 */
async function scrapeDacErrorBox(page: Page): Promise<string> {
  try {
    const texts = await page.evaluate(() => {
      const sels = [
        '.validation-summary-errors',
        '.field-validation-error',
        '.alert-danger',
        '.alert-error',
        '[role="alert"]',
      ];
      const out: string[] = [];
      for (const sel of sels) {
        const nodes = Array.from(document.querySelectorAll(sel));
        for (const n of nodes) {
          const t = (n as HTMLElement).innerText?.trim();
          if (t && t.length > 0) out.push(t);
        }
      }
      return out;
    });
    if (!Array.isArray(texts) || texts.length === 0) return '';
    // Pick the longest non-empty — usually the summary box has the
    // full validation list, single fields repeat it in fragments.
    const best = texts
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0)
      .sort((a, b) => b.length - a.length)[0];
    if (!best) return '';
    return best.length > 240 ? best.slice(0, 237) + '...' : best;
  } catch {
    // Page evaluation can fail mid-teardown; never let scraping
    // interrupt the throw path.
    return '';
  }
}

/** Stable idempotency key for a tenant+order pair. */
function computeIdempotencyKey(tenantId: string, shopifyOrderId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${tenantId}:${shopifyOrderId}`)
    .digest('hex');
}

/**
 * C-4 guard. Throws DuplicateSubmitError if a PendingShipment row exists in
 * an ambiguous state (PENDING or ORPHANED) — both mean we don't know whether
 * DAC has a real guía we missed, so a reprocess would risk a duplicate DAC
 * shipment. Those require manual reconciliation via DAC historial.
 *
 * ── 2026-04-22 HOTFIX (double-shipping incident) ───────────────────────────
 * The prior design auto-deleted RESOLVED rows to allow "operator redo" based
 * on Shopify's `fulfillment_status=unfulfilled`. That assumed our own
 * Shopify fulfillment call always succeeds after a successful DAC guía —
 * in prod it DOES NOT: `fulfillOrderWithTracking` throws "No fulfillable
 * orders" (fulfillment_orders count=0) and `addOrderTag` returns 403,
 * both logged as non-fatal. The order stays unfulfilled in Shopify, the
 * next cron tick picks it up again, the RESOLVED row is auto-deleted, and
 * a second DAC guía is created. Every cron cycle = another duplicate guía
 * = DAC bills the tenant twice.
 *
 * The safe default is now: a RESOLVED row ALWAYS blocks a re-submit. If
 * the operator genuinely wants to redo a shipment (wrong address, etc.),
 * they must delete the PendingShipment + Label rows explicitly (via the
 * dashboard "redo" action, or via Prisma Studio). A tiny TTL-based escape
 * hatch (72h) remains so truly stale RESOLVED rows from long-ago cancelled
 * workflows don't block a fresh manual retry — 72h is far longer than the
 * Shopify-fulfill failure window, so it can't trigger the cron loop.
 *
 * PENDING / ORPHANED continue to block — if we never got a guía back,
 * there may be one in DAC historial we never linked, and reprocessing
 * would double-ship. Those paths need operator reconciliation first.
 */
const RESOLVED_TTL_MS = 72 * 60 * 60 * 1000; // 72h

export async function assertNoPriorSubmit(
  tenantId: string,
  shopifyOrderId: string,
  slog: StepLogger,
): Promise<void> {
  const prior = await db.pendingShipment.findUnique({
    where: {
      tenantId_shopifyOrderId: { tenantId, shopifyOrderId },
    },
    select: {
      status: true,
      resolvedGuia: true,
      submitAttemptedAt: true,
    },
  });
  if (!prior) return;

  if (prior.status === 'RESOLVED') {
    const ageMs = Date.now() - prior.submitAttemptedAt.getTime();

    // Recent RESOLVED — BLOCK. This is the hotfix: Shopify-fulfill can
    // fail silently and leave orders unfulfilled, causing the scheduler
    // to re-pick them every minute. Without this block we'd mint a
    // duplicate DAC guía on every cron tick.
    if (ageMs < RESOLVED_TTL_MS) {
      slog.warn(
        DAC_STEPS.SUBMIT_WAIT_NAV,
        `Refusing to re-submit order ${shopifyOrderId}: RESOLVED PendingShipment is still recent (age=${Math.round(ageMs / 1000)}s, guia=${prior.resolvedGuia ?? 'n/a'}). To force a redo, delete the PendingShipment + Label rows for this order.`,
        {
          priorStatus: prior.status,
          priorGuia: prior.resolvedGuia,
          priorAttemptAgoMs: ageMs,
          ttlMs: RESOLVED_TTL_MS,
        },
      );
      throw new DuplicateSubmitError(
        `Order ${shopifyOrderId} was already submitted to DAC (guía=${prior.resolvedGuia ?? 'n/a'}, ${Math.round(ageMs / 60000)} min ago). To reprocess, delete the PendingShipment and Label rows manually.`,
        prior.status,
        prior.resolvedGuia,
      );
    }

    // Stale RESOLVED (>72h old) — safe escape hatch for legitimate
    // operator redos that happen long after the Shopify-fulfill-failure
    // window has passed.
    slog.info(
      DAC_STEPS.SUBMIT_WAIT_NAV,
      `Clearing stale RESOLVED PendingShipment for order ${shopifyOrderId} (age=${Math.round(ageMs / 1000)}s, >72h — safe to redo)`,
      {
        priorGuia: prior.resolvedGuia,
        priorAttemptAgoMs: ageMs,
      },
    );
    try {
      await db.pendingShipment.delete({
        where: { tenantId_shopifyOrderId: { tenantId, shopifyOrderId } },
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2025'
      ) {
        throw err;
      }
    }
    return;
  }

  slog.warn(
    DAC_STEPS.SUBMIT_WAIT_NAV,
    `Refusing to re-submit order ${shopifyOrderId}: prior attempt exists (status=${prior.status}, guia=${prior.resolvedGuia ?? 'n/a'})`,
    {
      priorStatus: prior.status,
      priorGuia: prior.resolvedGuia,
      priorAttemptAgoMs: Date.now() - prior.submitAttemptedAt.getTime(),
    },
  );
  throw new DuplicateSubmitError(
    `Order ${shopifyOrderId} was already submitted to DAC (PendingShipment.status=${prior.status}). Manual reconciliation required — check DAC historial for the real guía before retrying.`,
    prior.status,
    prior.resolvedGuia,
  );
}

/**
 * C-4: insert the pre-Finalizar marker. On unique-constraint conflict (a
 * concurrent worker beat us) we throw DuplicateSubmitError — the caller
 * must NOT click Finalizar in that case.
 */
async function markSubmitAttempted(
  tenantId: string,
  shopifyOrderId: string,
  labelId: string | null,
): Promise<void> {
  const idempotencyKey = computeIdempotencyKey(tenantId, shopifyOrderId);
  try {
    await db.pendingShipment.create({
      data: {
        tenantId,
        shopifyOrderId,
        labelId,
        idempotencyKey,
        status: 'PENDING',
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new DuplicateSubmitError(
        `Concurrent submit detected for order ${shopifyOrderId}; PendingShipment row was created by another worker.`,
        'PENDING',
        null,
      );
    }
    throw err;
  }
}

/**
 * C-4: mark the submit resolved once the real guía is in hand. Safe no-op
 * if the row doesn't exist (e.g. the insert at markSubmitAttempted got
 * rolled back but extraction still succeeded — shouldn't happen but we
 * don't want that edge case to throw).
 */
async function markSubmitResolved(
  tenantId: string,
  shopifyOrderId: string,
  resolvedGuia: string,
): Promise<void> {
  try {
    await db.pendingShipment.updateMany({
      where: {
        tenantId,
        shopifyOrderId,
        status: { in: ['PENDING', 'ORPHANED'] },
      },
      data: {
        status: 'RESOLVED',
        resolvedGuia,
        resolvedAt: new Date(),
      },
    });
  } catch (err) {
    // Non-fatal — we already have the real guía, the PendingShipment row
    // is for audit only. Log and continue.
    logger.warn(
      { error: (err as Error).message, tenantId, shopifyOrderId, resolvedGuia },
      '[C-4] Failed to mark PendingShipment as RESOLVED',
    );
  }
}

// ---- Helpers ----

/**
 * Detects any LabelFlow-internal marker, tracking metadata, or ISO timestamp
 * that must NEVER leak into DAC's courier-visible observations field.
 *
 * HISTORY of this filter (each version added after a real leak was observed):
 *
 *   v1: /labelflow[-_ ]?(guia|error|gu[ií]a)/i
 *       Caught: "LabelFlow-GUIA: N"
 *       Missed: reversed order "Guía labelflow: N" (reported 2026-04-10)
 *
 *   v2: adds |gu[ií]a[-_ ]?labelflow branch (reversed order)
 *       Caught: "Guía labelflow: N" (adjacent)
 *       Missed: "Guía: labelflow: N" (colon between → separator not in [-_ ])
 *       Missed: "Fecha: 2026-04-06T17:12:57.789Z" (no labelflow word at all)
 *
 *   v3 (this version): replaces the single regex with a suite of 4 independent
 *       SIGNALS. Any signal triggers a block. Together they cover every
 *       observed real-world leak and are defensive against future variants.
 *
 * Exported for isolated unit testing.
 */

/** Signal 1: Any case-insensitive appearance of "labelflow" in the text. */
export const LABELFLOW_WORD_RE = /labelflow/i;

/** Signal 2: The bare Spanish/English word for guide/guía/tracking/fecha/timestamp. */
export const INTERNAL_METADATA_NAME_RE =
  /^\s*(gu[ií]a|guia|tracking|fecha|timestamp|label|internal|meta|system|__)/i;

/** Signal 3: An ISO-8601 timestamp anywhere in the text (e.g. 2026-04-06T17:12:57.789Z). */
export const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[tT ]\d{2}:\d{2}:\d{2}/;

/** Signal 4: A standalone 10+ digit numeric ID (likely a DAC guia or tracking code). */
export const LONG_NUMERIC_ID_RE = /^\s*\d{10,}\s*$/;

/**
 * Signal 5 (added 2026-05-11): the diagnostic paragraphs LabelFlow writes
 * to the Shopify order note on failure. These DO contain the literal word
 * "LabelFlow" on their FIRST line, so the existing LABELFLOW_WORD_RE
 * filter catches that line. But the note is multi-paragraph and the
 * downstream lines (the AI verdict, the operator action steps, the
 * "IMPORTANTE" footer) DON'T re-mention "LabelFlow" — so a line-by-line
 * filter let them through to DAC observations on the next retry attempt.
 *
 * Production trigger: order #11997 (Camila Ibarra, 2026-05-11). First
 * attempt failed → worker wrote a verbose multi-paragraph note to
 * Shopify. Operator manually re-processed via "Procesar Ahora" → worker
 * read the note back from Shopify → only the "LabelFlow: DAC NO
 * confirmó..." line was filtered → the "AI análisis: ...", "ACCIÓN del
 * operador:", and the numbered operator instructions all leaked into
 * the DAC observations on the second attempt. The DAC printed label
 * said "supermercado gaona | contactar por telefono para numero de
 * puerta | ai análisis: dirección incompleta..." when it should have
 * just said "supermercado gaona | contactar por telefono para numero
 * de puerta".
 *
 * Patterns observed in the verbose note that should NEVER leak to DAC:
 *   - "AI análisis: …"      / "AI verdict: …"     (Claude's reasoning)
 *   - "ACCIÓN del operador" (instructions to the human operator)
 *   - "IMPORTANTE: el worker NO va a reintentar…"
 *   - Numbered operator steps ("1. Entrar a DAC → Historial → buscar última guía…")
 *   - "PendingShipment", "vincular guía" (internal mechanism names)
 *
 * The regex below is a union of these markers. Anchored at start-of-line
 * where possible to avoid false-positives on customer notes that
 * happen to contain similar words mid-sentence.
 */
export const LABELFLOW_INTERNAL_NOTE_RE =
  /^\s*(AI\s+(an[áa]lisis|verdict|reasoning)|ACCI[ÓO]N\s+del\s+operador|IMPORTANTE:\s*el\s+worker|\d+\.\s+(Entrar\s+a\s+DAC|Si\s+la\s+gu[íi]a|Revisar\s+la\s+direcci[óo]n))/i;

/** Signal 6 (added 2026-05-11): inline LabelFlow-internal keywords (not
 * line-anchored). Catches lines that reference our internal mechanisms by
 * name even when wrapped in a sentence — e.g. "...desbloquear esta orden
 * (admin → eliminar PendingShipment)..." or "...vincular guía manualmente..."
 */
export const LABELFLOW_INTERNAL_KEYWORD_RE =
  /\b(PendingShipment|vincular\s+gu[íi]a|gu[íi]a\s+hu[éeèê]rfana|orphan\s+gu[íi]a|rescue\s+del\s+historial)\b/i;

/**
 * Legacy alias kept for any external caller that still imports the v1/v2 name.
 * Prefer isLabelflowInternal() for new code.
 */
export const LABELFLOW_MARKER_RE = LABELFLOW_WORD_RE;

/**
 * True if the given text contains ANY LabelFlow-internal marker, tracking
 * metadata, ISO timestamp, or diagnostic paragraph that should not leak
 * into DAC observations.
 *
 * This is the authoritative check used by the sanitizer. Any caller that
 * needs to gate content before sending to DAC should use this function.
 */
export function isLabelflowInternal(text: string): boolean {
  if (!text) return false;
  if (LABELFLOW_WORD_RE.test(text)) return true;
  if (ISO_TIMESTAMP_RE.test(text)) return true;
  if (LABELFLOW_INTERNAL_NOTE_RE.test(text)) return true;
  if (LABELFLOW_INTERNAL_KEYWORD_RE.test(text)) return true;
  return false;
}

/**
 * Stricter variant for note_attribute NAME/VALUE pairs. In addition to the
 * isLabelflowInternal() checks, this also blocks attributes whose name starts
 * with internal-metadata keywords (guia, tracking, fecha, timestamp, label, etc.)
 * or whose value is purely a long numeric ID.
 */
export function shouldSkipNoteAttribute(name: string, value: string): boolean {
  const n = name ?? '';
  const v = String(value ?? '');
  if (isLabelflowInternal(n) || isLabelflowInternal(v)) return true;
  if (INTERNAL_METADATA_NAME_RE.test(n)) return true;
  if (LONG_NUMERIC_ID_RE.test(v)) return true;
  return false;
}

/**
 * Strip any piece of text (split by newlines or pipe separators) that contains a
 * LabelFlow-internal marker, ISO timestamp, or standalone long numeric ID. Used
 * as the final belt-and-suspenders pass before filling DAC's observations field.
 *
 * Uses isLabelflowInternal() + LONG_NUMERIC_ID_RE for detection — see the header
 * comment on LABELFLOW_WORD_RE for the full filter architecture.
 */
export function sanitizeObservationLine(raw: string): string {
  return raw
    .split(/[\n|]/)
    .filter(piece => {
      const trimmed = piece.trim();
      if (!trimmed) return false;
      if (isLabelflowInternal(trimmed)) return false;
      if (LONG_NUMERIC_ID_RE.test(trimmed)) return false;
      return true;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Montevideo barrio aliases: maps common names/variations to the canonical
 * name DAC uses in its K_Barrio dropdown. This lets us match "Punta Carretas",
 * "Pta Carretas", "Punta carretas" etc. to the right dropdown option.
 */
const MONTEVIDEO_BARRIO_ALIASES: Record<string, string[]> = {
  'aguada': ['aguada', 'la aguada montevideo'],
  'aires puros': ['aires puros'],
  'atahualpa': ['atahualpa'],
  'barrio sur': ['barrio sur', 'bsur'],
  'belvedere': ['belvedere'],
  'brazo oriental': ['brazo oriental'],
  'buceo': ['buceo'],
  'capurro': ['capurro'],
  'carrasco': ['carrasco'],
  'carrasco norte': ['carrasco norte'],
  'casabo': ['casabo'],
  'casavalle': ['casavalle'],
  'centro': ['centro'],
  'cerrito': ['cerrito', 'cerrito de la victoria'],
  'cerro': ['cerro'],
  'ciudad vieja': ['ciudad vieja', 'casco viejo'],
  'colon': ['colon', 'columbus'],
  'cordon': ['cordon', 'el cordon'],
  'flor de maronas': ['flor de maronas'],
  'goes': ['goes', 'villa goes'],
  'jacinto vera': ['jacinto vera'],
  'jardines del hipódromo': ['jardines del hipodromo', 'jardines hipodromo'],
  'la blanqueada': ['la blanqueada', 'blanqueada'],
  'la comercial': ['la comercial', 'comercial'],
  'la figurita': ['la figurita', 'figurita'],
  'la teja': ['la teja', 'teja'],
  'larrañaga': ['larranaga'],
  'las acacias': ['las acacias', 'acacias'],
  'las canteras': ['las canteras', 'canteras'],
  'lezica': ['lezica'],
  'malvin': ['malvin'],
  'malvin norte': ['malvin norte'],
  'manga': ['manga'],
  'maronas': ['maronas'],
  'mercado modelo': ['mercado modelo'],
  'nuevo paris': ['nuevo paris'],
  'palermo': ['palermo'],
  'parque batlle': ['parque batlle', 'parque battle', 'parque batle'],
  'parque rodo': ['parque rodo'],
  'paso de la arena': ['paso de la arena', 'paso arena'],
  'paso de las duranas': ['paso de las duranas', 'paso duranas'],
  'peñarol': ['penarol'],
  'piedras blancas': ['piedras blancas'],
  'pocitos': ['pocitos'],
  'pocitos nuevo': ['pocitos nuevo'],
  'prado': ['prado'],
  'punta carretas': ['punta carretas', 'pta carretas', 'punta carreta'],
  'punta de rieles': ['punta de rieles'],
  'punta gorda': ['punta gorda', 'pta gorda'],
  'reducto': ['reducto', 'el reducto'],
  'sayago': ['sayago'],
  'sur': ['barrio sur montevideo'],  // removed bare 'sur' — too short, conflicts with city "Sur" in Artigas. Use 'barrio sur' alias instead.
  'tres cruces': ['tres cruces', '3 cruces'],
  'tres ombues': ['tres ombues', '3 ombues'],
  'union': ['union', 'la union'],
  'villa dolores': ['villa dolores'],
  'villa española': ['villa espanola'],
  'villa garcia': ['villa garcia'],
  'villa muñoz': ['villa munoz'],
};

/**
 * Try to detect the barrio from any address-related text fields.
 * Checks city, address1, address2 for known Montevideo barrio names.
 */
function detectBarrio(city: string, address1: string, address2: string): string | null {
  const combined = normalize(`${city} ${address1} ${address2}`);

  // Build flat list of [canonical, alias] pairs sorted by alias length DESC
  // This ensures "malvin norte" is checked before "malvin", "carrasco norte" before "carrasco", etc.
  const allAliases: [string, string][] = [];
  for (const [canonical, aliases] of Object.entries(MONTEVIDEO_BARRIO_ALIASES)) {
    for (const alias of aliases) {
      allAliases.push([canonical, normalize(alias)]);
    }
  }
  allAliases.sort((a, b) => b[1].length - a[1].length);

  for (const [canonical, normalizedAlias] of allAliases) {
    // Word boundary check: ensure we match the whole barrio name, not partial
    // e.g. "centro" should not match "concentrar"
    const regex = new RegExp(`\\b${normalizedAlias.replace(/\s+/g, '\\s+')}\\b`);
    if (regex.test(combined)) {
      return canonical;
    }
  }
  return null;
}

interface IntelligentCityResult {
  barrio: string | null;
  department: string | null;
  source: 'zip' | 'street' | 'alias' | 'none';
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Intelligent city/barrio detection using multiple strategies:
 * 1. ZIP confirms alias  — highest confidence (ZIP + Shopify agree)
 * 2. Shopify alias alone — customer explicitly named a barrio; trust it over inference
 * 3. ZIP + street cross-reference — no explicit barrio, two signals agree
 * 4. ZIP alone           — single signal fallback
 * 5. Street name alone
 * 6. Department from ZIP only
 *
 * IMPORTANT: Shopify alias (from city/address fields) always wins over ZIP-only
 * inference. ZIP codes in Uruguay are imprecise and map to multiple barrios; the
 * customer's own barrio name is more specific and should not be overridden.
 */
export function detectCityIntelligent(
  city: string,
  address1: string,
  address2: string,
  zip: string,
): IntelligentCityResult {
  const aliasBarrio = detectBarrio(city, address1, address2);
  const zipBarrios = getBarriosFromZip(zip);
  const streetBarrios = getBarriosFromStreet(address1) ?? getBarriosFromStreet(address2);
  const zipDept = getDepartmentFromZip(zip);

  // Strategy 1: ZIP confirms the alias — both signals agree, highest confidence
  if (zipBarrios && aliasBarrio && zipBarrios.includes(aliasBarrio)) {
    return { barrio: aliasBarrio, department: zipDept, source: 'zip', confidence: 'high' };
  }

  // Strategy 2: Shopify explicitly named a barrio — trust it over ZIP/street inference.
  // ZIP maps to multiple candidates; the customer's own city name is more specific.
  if (aliasBarrio) {
    return { barrio: aliasBarrio, department: zipDept ?? 'Montevideo', source: 'alias', confidence: 'medium' };
  }

  // No explicit barrio from the customer — do NOT guess.
  // Previous versions inferred a barrio from ZIP alone (picking zipBarrios[0]) or
  // from street-name heuristics. In practice Uruguayan ZIPs map to 3-4 barrios
  // (e.g. 11400 → la blanqueada / goes / reducto / brazo oriental), so picking
  // the first candidate was wrong most of the time. Per product decision on
  // 2026-04-20: when the customer did not name a barrio, submit DAC with
  // department only and leave barrio blank.
  //
  // We still return the ZIP-derived department (and Montevideo as fallback for
  // Montevideo-only street matches) so routing is correct; we just keep
  // confidence high so the AI fallback isn't invoked to hallucinate a barrio.
  if (zipBarrios && zipBarrios.length > 0) {
    return { barrio: null, department: zipDept, source: 'zip', confidence: 'high' };
  }
  if (streetBarrios && streetBarrios.length > 0) {
    return { barrio: null, department: zipDept ?? 'Montevideo', source: 'street', confidence: 'high' };
  }

  // Fallback: only department from ZIP (or null if ZIP didn't match anything)
  return { barrio: null, department: zipDept, source: 'none', confidence: 'low' };
}

/**
 * Decide whether the AI resolver (Claude Haiku, ~1¢/call) should be invoked
 * for a given deterministic detection result. Extracted from the shipment
 * pipeline as a pure function so the decision logic is unit-testable.
 *
 * Trigger conditions (any one is enough):
 *  1. Low confidence                          — deterministic is guessing.
 *  2. Medium confidence + no barrio           — alias matched but no geographic anchor.
 *  3. No barrio and no department             — deterministic returned nothing useful.
 *  4. Montevideo resolved but barrio still null — ZIP mapped to Montevideo but the
 *     ZIP→barrio table is ambiguous (e.g. 11600 → [buceo, malvin, malvin norte])
 *     and the street is not in MVD_STREET_RANGES. DAC rejects Montevideo forms
 *     without a barrio, so deterministic "high confidence dept-only" is a false
 *     positive here. Added 2026-04-22 for the #11492 regression (Adriana Abeijon,
 *     "Juan Ortíz 3315, Mvdo., 11600" — customer typed a Montevideo alias with
 *     an ambiguous ZIP and a street not in our hand-verified table).
 */
export function shouldInvokeAIResolver(intelligent: IntelligentCityResult): boolean {
  const mvdWithoutBarrio =
    normalize(intelligent.department ?? '') === 'montevideo' && !intelligent.barrio;
  return (
    intelligent.confidence === 'low' ||
    (intelligent.confidence === 'medium' && !intelligent.barrio) ||
    (!intelligent.barrio && !intelligent.department) ||
    mvdWithoutBarrio
  );
}

// ──────────────────────────────────────────────────────────────────────────
// mergeAddress — helper utilities (exported for unit testing)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Strip a trailing apartment-style suffix from an address line.
 *
 * Matches patterns the customer commonly types at the END of address1:
 *   - "..., apto 110"            → cleaned address, "Apto 110"
 *   - "...Apto 1202"             → cleaned address, "Apto 1202"
 *   - "...apt 5B"                → cleaned address, "Apto 5B"
 *   - "...dpto 304"              → cleaned address, "Apto 304"
 *   - "...apartamento 7"         → cleaned address, "Apto 7"
 *
 * Returns the original address unchanged if no apt pattern is at the end.
 * Exported so tests can verify each pattern in isolation.
 */
export function stripTrailingAptPattern(addr: string): { cleaned: string; apt: string } {
  if (!addr) return { cleaned: addr, apt: '' };
  // Word-boundary match for apt-style words at the very end of the string.
  // Captures the value after the apt word (could be alphanumeric like "5B", "1202", "110")
  const re = /[\s,]+(?:apto|apt|apartamento|dpto|depto|dep|ap)\.?\s+(\S+)\s*$/i;
  const m = addr.match(re);
  if (!m) return { cleaned: addr, apt: '' };
  const cleaned = addr.slice(0, m.index).trim().replace(/[,\s]+$/, '');
  return { cleaned, apt: `Apto ${m[1]}` };
}

/**
 * Strip a trailing "Porteria X" / "Portería X" suffix from an address line.
 *
 * Customers sometimes write "Calle X 410 Porteria 410" — the "Porteria 410"
 * part is an instruction for the doorman/concierge, not part of the street
 * address. It belongs in observations.
 */
export function stripTrailingPorteriaPattern(addr: string): { cleaned: string; porteria: string } {
  if (!addr) return { cleaned: addr, porteria: '' };
  const re = /[\s,]+porter[ií]a\s+(\S+)\s*$/i;
  const m = addr.match(re);
  if (!m) return { cleaned: addr, porteria: '' };
  const cleaned = addr.slice(0, m.index).trim().replace(/[,\s]+$/, '');
  return { cleaned, porteria: `Porteria ${m[1]}` };
}

/**
 * Strip trailing known-place suffixes from an address line.
 *
 * Customers sometimes write the full hierarchical address into address1,
 * e.g. "Guenoas, manzana L6, solar 8, El Pinar, ciudad de la costa".
 * The barrio ("El Pinar") and city ("ciudad de la costa") are already going
 * to DAC's K_Barrio and K_Ciudad dropdowns — they shouldn't be repeated in
 * the street address text.
 *
 * Strips the LAST comma-separated segment if it matches a known Uruguayan
 * city/barrio name. Iterates up to 5 times in case multiple known names are
 * stacked at the end.
 */
/**
 * H-5 (2026-04-21 audit): STRIP_DENY_LIST contains entries from
 * CITY_TO_DEPARTMENT that are ALSO common Spanish words, cardinal directions,
 * or street-name components. Even though ANTEL/INE lists them as real
 * localities, stripping them as trailing "place names" in a freeform
 * customer-typed address causes more harm than good:
 *
 *   "Av Cerro 1200, sur"          — "sur" is a cardinal direction
 *                                   (note: Artigas has a rural locality
 *                                   literally named "sur"). Stripping it
 *                                   would mangle a valid MVD address.
 *   "Rbla Gandhi 500, rambla"     — "rambla" is part of street naming
 *                                   convention; treating it as a "place"
 *                                   to strip is always wrong.
 *   "Calle X 100, centro"         — "centro" is ambiguous; keeping it
 *                                   in the address text is safer.
 *
 * Any future maintenance of CITY_TO_DEPARTMENT must re-evaluate this list:
 * if an entry added there looks like a common-word collision, add it here.
 */
const STRIP_DENY_LIST = new Set<string>([
  // Cardinal directions (generic)
  'sur', 'norte', 'este', 'oeste',
  // Downtown / generic (also MVD barrio)
  'centro',
  // Waterfront / coast (used in Montevideo street addressing)
  'rambla', 'rbla',
  'playa', 'costa',
  // Hill / port (generic geography)
  'cerro', 'puerto',
  // Very short / highly ambiguous entries (1–3 chars)
  'chuy', 'melo', 'tala', 'soca', 'goes', 'risso',
]);

/**
 * H-5: build KNOWN_PLACES_FOR_STRIP from CITY_TO_DEPARTMENT (~540 entries)
 * MINUS the deny-list. The previous hardcoded list of 53 missed dozens of
 * real trailing cities like "Paso Carrasco", "Lomas de Solymar", "Salinas",
 * leaving them in the DAC street field even though K_Ciudad already covers
 * them. Expanding from CITY_TO_DEPARTMENT guarantees strip coverage aligns
 * with the department resolver's coverage.
 */
const KNOWN_PLACES_FOR_STRIP: ReadonlySet<string> = new Set(
  Object.keys(CITY_TO_DEPARTMENT).filter((k) => !STRIP_DENY_LIST.has(k)),
);

/**
 * Strip trailing ", place" suffixes while defending against the three most
 * likely ways an over-eager stripper can corrupt an address:
 *
 *   Safeguard A — the REMAINING prefix must contain at least one digit.
 *       Blocks "1234, Montevideo" → "" or "Pocitos, Montevideo" → "Pocitos"
 *       (no door number, courier can't find it).
 *
 *   Safeguard B — the REMAINING prefix must contain at least one alphabetic
 *       word of length ≥ 2. Blocks "1234, Montevideo" → "1234" (no street
 *       name, courier only has a number).
 *
 *   Deny-list  — STRIP_DENY_LIST above stops stripping for direction words,
 *       beach/hill/port geography, and ambiguous 3–4 letter city names.
 *
 * Each successful strip is logged at info level with the before/after text
 * so we can audit behavior in production for 1 week before trusting it.
 */
export function stripTrailingKnownPlaces(addr: string): string {
  if (!addr) return addr;
  let cleaned = addr;
  for (let i = 0; i < 5; i++) {
    // Match LAST ", segment" at end of string.
    const m = cleaned.match(/^(.+),\s*([^,]+)$/);
    if (!m) break;
    const prefix = m[1].trim();
    const lastSegment = m[2].trim().toLowerCase();
    if (!KNOWN_PLACES_FOR_STRIP.has(lastSegment)) break;

    // Safeguard A — remaining prefix must have a digit (real door number).
    if (!/\d/.test(prefix)) {
      logger.debug({
        input: cleaned, segment: lastSegment, reason: 'prefix_has_no_digit',
      }, 'stripTrailingKnownPlaces: skipped — prefix has no door number');
      break;
    }

    // Safeguard B — remaining prefix must have a real alphabetic word.
    // `[a-záéíóúñ]{2,}` handles accented UY street names (Río, España, Peñarol).
    if (!/[a-záéíóúñ]{2,}/i.test(prefix)) {
      logger.debug({
        input: cleaned, segment: lastSegment, reason: 'prefix_has_no_alpha_word',
      }, 'stripTrailingKnownPlaces: skipped — prefix has no street name');
      break;
    }

    logger.info({
      input: cleaned, segment: lastSegment, result: prefix,
    }, 'stripTrailingKnownPlaces: stripped trailing known place');
    cleaned = prefix;
  }
  return cleaned;
}

/**
 * Detect when address1 has EXACTLY ONE number that equals address2's numeric
 * value. This catches the false-positive apt extraction case where the customer
 * mistakenly typed the door number twice (e.g. "Cuató 3117" + "3117").
 *
 * Returns true if address2 should be treated as a duplicate of the door number,
 * NOT as an apartment number.
 */
export function isAddress2DuplicateOfDoor(a1: string, a2: string): boolean {
  if (!a1 || !a2) return false;
  // address2 must be a bare number
  if (!/^\d{1,6}$/.test(a2.trim())) return false;
  // Find all numbers in address1
  const a1Numbers = a1.match(/\d+/g) ?? [];
  // Only one number AND it matches address2
  return a1Numbers.length === 1 && a1Numbers[0] === a2.trim();
}

/**
 * Heuristic: is this bare numeric string "obviously" an apartment number?
 *
 * In Uruguay:
 *   - Apt numbers usually have a leading zero (002, 005, 012) or are very short
 *     (1, 5, 12) — those are unambiguous apt numbers.
 *   - Door numbers are usually 3+ digits (100, 1234, 12345) and never have a
 *     leading zero.
 *   - 3+ digit numbers WITHOUT a leading zero are AMBIGUOUS — could be either.
 *
 * This function returns true ONLY for the "obviously apt" cases. Ambiguous
 * digits (e.g. "705") return false, which lets the caller treat them as
 * duplicate door numbers when they appear at the end of address1.
 *
 * Real-world cases this distinguishes:
 *   - "Rbla...4507 002" + "002"   → "002" leading zero → APT
 *   - "18 De Julio 705" + "705"   → "705" 3 digits, no leading zero → NOT apt
 *   - "Cuató 3117" + "3117"       → caught earlier by isAddress2DuplicateOfDoor
 *   - "Calle X 1234 5" + "5"      → "5" length 1 → APT
 *   - "Calle X 1234 56" + "56"    → "56" length 2 → APT
 */
export function isLikelyAptNumber(s: string): boolean {
  const t = s.trim();
  if (!/^\d{1,5}$/.test(t)) return false;
  // Leading zero is a strong signal of apt (no street uses door "002")
  if (t.startsWith('0') && t.length >= 2) return true;
  // 1-2 digit numbers are unambiguously apt (no street uses door "5")
  if (t.length <= 2) return true;
  // 3+ digit non-leading-zero numbers are AMBIGUOUS — caller decides
  return false;
}

/**
 * Combine an existing extraObs string with a new piece, joining with " | "
 * if both are present. Avoids duplicating content already present.
 */
function combineObs(existing: string, addition: string): string {
  const e = (existing || '').trim();
  const a = (addition || '').trim();
  if (!a) return e;
  if (!e) return a;
  // Avoid duplicate (case-insensitive substring check)
  if (e.toLowerCase().includes(a.toLowerCase())) return e;
  return `${e} | ${a}`;
}

/**
 * Final post-processing pass that runs after the main mergeAddress logic.
 * Cleans the fullAddress of any embedded apt/porteria/city patterns and
 * promotes them to extraObs. Idempotent and safe to call on already-clean
 * input.
 */
export function postProcessAddress(
  fullAddress: string,
  extraObs: string,
): { fullAddress: string; extraObs: string } {
  let addr = fullAddress;
  let obs = extraObs;

  // 1. Strip trailing apt pattern (Apto X / apto X / dpto X / etc)
  const aptStrip = stripTrailingAptPattern(addr);
  if (aptStrip.apt) {
    addr = aptStrip.cleaned;
    obs = combineObs(obs, aptStrip.apt);
  }

  // 2. Strip trailing Porteria pattern
  const porteriaStrip = stripTrailingPorteriaPattern(addr);
  if (porteriaStrip.porteria) {
    addr = porteriaStrip.cleaned;
    obs = combineObs(obs, porteriaStrip.porteria);
  }

  // 3. Strip trailing standalone number when extraObs already has a matching apt
  // (catches "Rbla...4507 002" + obs="Apto 002" → strip the trailing 002)
  const aptInObsMatch = obs.match(/apto\s+(\S+)/i);
  if (aptInObsMatch) {
    const aptValue = aptInObsMatch[1];
    // Only strip if address has 2+ numbers (not the only door number)
    const addrNumbers = addr.match(/\d+/g) ?? [];
    if (addrNumbers.length >= 2 && addr.trim().endsWith(aptValue)) {
      addr = addr.slice(0, addr.lastIndexOf(aptValue)).trim().replace(/[,\s]+$/, '');
    }
  }

  // 4. Strip embedded city/dept names from end of address
  addr = stripTrailingKnownPlaces(addr);

  return { fullAddress: addr, extraObs: obs };
}

/**
 * Detect when the customer swapped address1 and address2 — i.e. the delivery
 * observation was typed in address1 and the real street went into address2.
 *
 * Real-world case (2026-04-22 post-run audit, order #11480 Mariana Gestal):
 *   address1 = "Portón De Garaje Gris(contenedor De Basura En La Puerta)"  ← obs
 *   address2 = "Dolores Pereira De Rosell 1474"                             ← street
 * The label was printed with "Portón De Garaje Gris..." in the street field
 * and the real address buried in the observations. Courier couldn't deliver.
 *
 * Trigger conditions (ALL must hold):
 *   1. address1 contains NO digits at all — every deliverable Uruguayan
 *      street address has a door number, so "zero digits" is a strong signal
 *      that address1 is pure prose (observation).
 *   2. address1 has ≥ 3 alpha words of length ≥ 2. A bare no-number address1
 *      like "Av Rivera" (2 words) is a data-incomplete case, NOT a swap —
 *      the real street might actually be in address1 with a missing door #.
 *      Observations in the Mariana real case have many words ("Portón De
 *      Garaje Gris contenedor De Basura En La Puerta" = 10 words) so the
 *      3-word threshold cleanly separates observation-prose from bare street
 *      names while preserving the existing "real address that contains city"
 *      unit-test contract (address1="Av Rivera", 2 words → no swap).
 *   3. address2 contains at least one digit (candidate door number).
 *   4. address2 has ≥ 2 alphabetic words of length ≥ 2 (so it's a real
 *      street phrase like "Dolores Pereira 1474", not just a phone number
 *      or apt code like "301").
 *
 * When all four hold we return the swapped pair so downstream merge logic
 * treats address2-as-address1 (the real street) and address1-as-address2
 * (an observation that mergeAddressCore's "EVERYTHING ELSE" branch will
 * route straight into extraObs).
 *
 * Exported for unit testing.
 */
export function maybeSwapSwappedFields(
  address1: string,
  address2: string | undefined | null,
): { address1: string; address2: string; swapped: boolean } {
  const a1 = (address1 ?? '').trim();
  const a2 = (address2 ?? '').trim();
  if (!a1 || !a2) return { address1: a1, address2: a2, swapped: false };

  // Condition 1: address1 has no digits
  if (/\d/.test(a1)) return { address1: a1, address2: a2, swapped: false };

  // Condition 2: address1 has ≥ 3 alpha words
  const a1AlphaWords = a1
    .split(/\s+/)
    .filter((w) => /[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,}/.test(w)).length;
  if (a1AlphaWords < 3) return { address1: a1, address2: a2, swapped: false };

  // Condition 3: address2 has at least one digit
  if (!/\d/.test(a2)) return { address1: a1, address2: a2, swapped: false };

  // Condition 4: address2 has ≥ 2 alpha words (≥ 2 chars each)
  const a2AlphaWords = a2
    .split(/\s+/)
    .filter((w) => /[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,}/.test(w)).length;
  if (a2AlphaWords < 2) return { address1: a1, address2: a2, swapped: false };

  // All four hold → customer swapped the fields. Flip them.
  return { address1: a2, address2: a1, swapped: true };
}

/**
 * Merge address1 + address2 into a clean delivery address + observaciones.
 *
 * PHILOSOPHY (v3 — April 2026):
 *   - fullAddress = ONLY the street + door number (what DAC needs for delivery)
 *   - extraObs = EVERYTHING else (apt, floor, delivery notes, pickup info)
 *   - address2 almost NEVER goes into fullAddress — it goes to observaciones
 *   - Only exception: address2 is a pure door number that address1 is missing
 *
 * v3 adds a postProcessAddress() pass that catches embedded apt/porteria/city
 * patterns the customer typed inside address1 itself (not as a separate
 * address2). See the helpers above for the full pattern catalog and the
 * Curva Divina audit (2026-04-10) for the real-world cases that motivated
 * each pattern.
 *
 * v3 also fixes the false-positive case where address1 has exactly one number
 * and address2 contains the same number — previously this was extracted as an
 * "Apto X" duplicate, but it's actually the door number repeated by mistake.
 *
 * v4 (2026-04-22 post-run audit): pre-pass detects and flips the "customer
 * swapped the fields" case via maybeSwapSwappedFields() before any merge
 * logic runs. See that function for the detection rules and real case.
 */
export function mergeAddress(address1: string, address2: string | undefined | null): { fullAddress: string; extraObs: string } {
  // v4 (2026-04-22): pre-pass. If the customer wrote the observation in the
  // address1 field and the real street in address2, flip them so the rest of
  // the merge logic operates on the correct-order inputs.
  const swap = maybeSwapSwappedFields(address1, address2);
  if (swap.swapped) {
    logger.info(
      {
        originalAddress1: address1,
        originalAddress2: address2,
        correctedAddress1: swap.address1,
        correctedAddress2: swap.address2,
      },
      'mergeAddress: detected swapped fields — flipping address1/address2',
    );
  }
  const result = mergeAddressCore(swap.address1, swap.address2);
  // v3 (2026-04-10): post-process the result to strip embedded apt/porteria/city
  // patterns the customer typed inside address1 itself. See postProcessAddress.
  return postProcessAddress(result.fullAddress, result.extraObs);
}

/**
 * Internal core merge logic. The public mergeAddress() wraps this with the
 * v3 postProcessAddress() pass. Don't call this directly — call mergeAddress.
 */
function mergeAddressCore(address1: string, address2: string | undefined | null): { fullAddress: string; extraObs: string } {
  const a1 = (address1 ?? '').trim();
  const a2 = (address2 ?? '').trim();

  // SLASH APT in address1 — works EVEN when address2 has other content.
  // Customer wrote "Luis a de Herrera 1183/204" which is street + door/apt slash form.
  // Split into "Luis a de Herrera 1183" + "Apto 204" so the address line is clean.
  // The address2 content (if any) is appended to the obs.
  //
  // H-6 (2026-04-21 audit): two refinements to the slash detection:
  //   1. Accept LETTER and NUMBER+LETTER apts: "1183/B" → Apto B,
  //      "1183/6B" → Apto 6B. The old pattern required `\d+` on both sides.
  //   2. Guard against "Ruta X km N/Q" patterns (rural km sub-markers). The
  //      old regex happily split "Ruta 9 km 120/5" into door=120 apt=5, which
  //      is wrong — that's a kilometer sub-section on a highway, not an apt.
  //      The `\bkm\b` check rejects the split without breaking normal street
  //      addresses (Kimberley, kilogramos, etc. all fail word-boundary test).
  const SLASH_APT_RX = /(\d+)\s*\/\s*(\d+[A-Za-z]?|[A-Za-z])\s*$/;
  const hasKmMarker = /\bkm\b/i.test(a1);
  const slashApt = hasKmMarker ? null : SLASH_APT_RX.exec(a1);
  if (slashApt) {
    const cleanedA1 = a1.slice(0, slashApt.index).trim() + ' ' + slashApt[1];
    const aptObs = `Apto ${slashApt[2]}`;
    if (!a2) {
      return { fullAddress: cleanedA1, extraObs: aptObs };
    }
    // Recurse with the cleaned address1 to apply other rules to the address2 content
    const inner = mergeAddressCore(cleanedA1, a2);
    return {
      fullAddress: inner.fullAddress,
      extraObs: inner.extraObs ? `${aptObs} | ${inner.extraObs}` : aptObs,
    };
  }

  if (!a2) {
    // "Puerta X" embedded in address1 (e.g. "Cuató 3117 Puerta 3") — extract to obs
    // "Puerta" in Uruguay = entrance/door code, NOT an apartment number
    const puertaMatch = /\s+[Pp]uerta\s+\S+\s*$/.exec(a1);
    if (puertaMatch) {
      return { fullAddress: a1.slice(0, puertaMatch.index).trim(), extraObs: puertaMatch[0].trim() };
    }
    return { fullAddress: a1, extraObs: '' };
  }

  // SINGLE-NUMBER SELF-DUPLICATE: address1 has exactly one number AND address2
  // contains the same number. The customer mistakenly typed the door number
  // twice. Example: "Cuató 3117" + "3117". This is NOT an apartment number —
  // it's the door number duplicated. Treat address2 as a no-op duplicate.
  if (isAddress2DuplicateOfDoor(a1, a2)) {
    return { fullAddress: a1, extraObs: '' };
  }

  // PHONE NUMBER: address2 is a phone number — discard entirely
  const a2Digits = a2.replace(/[\s-]/g, '');
  if (/^0\d{7,}$/.test(a2Digits) || /^(\+?598|09[0-9])\d{5,}$/.test(a2Digits) || /^\d{8,}$/.test(a2Digits)) {
    return { fullAddress: a1, extraObs: '' };
  }

  // CITY/DEPARTMENT: address2 is just a city or department name — discard
  const KNOWN_PLACES = [
    'montevideo', 'canelones', 'maldonado', 'salto', 'paysandu', 'rivera', 'tacuarembo',
    'colonia', 'soriano', 'rocha', 'florida', 'durazno', 'artigas', 'treinta y tres',
    'cerro largo', 'lavalleja', 'san jose', 'flores', 'rio negro', 'pocitos', 'buceo',
    'carrasco', 'punta carretas', 'centro', 'cordon', 'parque rodo', 'malvin', 'union',
    'la blanqueada', 'tres cruces', 'prado', 'lagomar', 'la floresta', 'las piedras',
    'ciudad de la costa', 'pando', 'barros blancos', 'piriapolis', 'punta del este',
    'minas', 'fray bentos', 'mercedes', 'nueva palmira', 'young', 'carmelo',
    'el pinar', 'solymar', 'atlantida', 'parque del plata', 'sauce', 'progreso',
    'la paz', 'delta del tigre', 'san carlos', 'pan de azucar',
  ];
  if (KNOWN_PLACES.includes(a2.toLowerCase().trim())) {
    return { fullAddress: a1, extraObs: '' };
  }

  // DEDUP: if address2 is already contained in address1 (or is essentially the same info), don't append
  // BUT preserve the info in extraObs if it looks like apartment/unit info
  // Uses substring match + word-overlap (80%+) to handle "Retiro dac maldonado" vs "Retiro en DAC Maldonado"
  const a1Norm = normalize(a1);
  const a2Norm = normalize(a2);
  const a2Words = a2Norm.split(/\s+/).filter(w => w.length > 1);
  const a1Words = new Set(a1Norm.split(/\s+/));
  const wordOverlap = a2Words.length > 0 ? a2Words.filter(w => a1Words.has(w)).length / a2Words.length : 0;
  const isDuplicate = a1.toLowerCase().includes(a2.toLowerCase()) || a1.endsWith(a2)
    || a1Norm.includes(a2Norm) || a2Norm.includes(a1Norm)
    || (a2Words.length >= 2 && wordOverlap >= 0.8);
  if (isDuplicate) {
    // Even though it's a duplicate, if it LOOKS like an apt number, preserve in obs.
    // v3 (2026-04-10): use isLikelyAptNumber to distinguish "obviously apt" (leading
    // zero or 1-2 digits) from "ambiguous 3+ digit number" (could be door duplicated).
    // Only treat as apt if isLikelyAptNumber returns true.
    if (/^\d{1,5}$/.test(a2)) {
      if (isLikelyAptNumber(a2)) {
        return { fullAddress: a1, extraObs: `Apto ${a2}` };
      }
      // Ambiguous 3+ digit number duplicating address1's door — treat as duplicate
      return { fullAddress: a1, extraObs: '' };
    }
    if (/apto|apt\b|piso|oficina|depto|of\.|local|torre|int\b|interior/i.test(a2)) {
      return { fullAddress: a1, extraObs: a2 };
    }
    return { fullAddress: a1, extraObs: '' };
  }

  // PURE DOOR NUMBER: address2 is just digits (e.g. "1607")
  if (/^\d{1,6}$/.test(a2)) {
    const a1EndsWithNum = /\d+\s*$/.test(a1);
    if (a1EndsWithNum) {
      // address1 already has a number — address2 is likely apartment.
      // v3: but if a2 matches the trailing number of a1 AND is ambiguous (3+ digits,
      // no leading zero), treat as a duplicated door, not an apt.
      const trailingMatch = a1.match(/(\d+)\s*$/);
      if (trailingMatch && trailingMatch[1] === a2 && !isLikelyAptNumber(a2)) {
        return { fullAddress: a1, extraObs: '' };
      }
      return { fullAddress: a1, extraObs: `Apto ${a2}` };
    }
    // address1 has no number — address2 is the door number, append it
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  // DOOR+APT combined: "1502B" or "502 A"
  const doorAptCombined = /^(\d{3,5})\s*([A-Za-z]\d{0,2})$/.exec(a2);
  if (doorAptCombined) {
    const a1EndsWithNum = /\d+\s*$/.test(a1);
    if (a1EndsWithNum) {
      // address1 already has door — this is apartment info
      return { fullAddress: a1, extraObs: `Apto ${a2}` };
    }
    return { fullAddress: `${a1} ${doorAptCombined[1]}`, extraObs: `Apto ${doorAptCombined[2]}` };
  }

  // DIRECTION REFERENCE: "esq Av Italia", "entre Colonia y Maldonado"
  // These go to BOTH address and obs (useful for courier navigation)
  // Word boundary (\b) prevents "Entregar" from matching "entre"
  if (/^(esq\b|entre\b|frente\b|al lado\b|cerca\b|junto\b|casi\b|a metros\b|esquina\b)/i.test(a2)) {
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  // NUMBER+BIS: "1234 bis"
  if (/^\d{1,6}\s+(bis|esq)/i.test(a2)) {
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  // EVERYTHING ELSE: apartment info, delivery notes, pickup instructions, etc.
  // ALL goes to extraObs ONLY — keep fullAddress clean
  // Examples: "303 apto", "Lunes a viernes 9-16", "Casa con cerco de polines",
  //   "oficina 1209 dejar en porteria", "804. Dejar en porteria con Foxys"
  return { fullAddress: a1, extraObs: a2 };
}

async function findBestOptionMatch(
  page: Page,
  selector: string,
  searchText: string
): Promise<string | null> {
  const options = await page.$$eval(
    `${selector} option`,
    (opts: any[]) => opts.map((o: any) => ({ value: o.value, text: o.textContent?.trim() ?? '' }))
  );

  const search = normalize(searchText);
  if (!search) return null;

  // Exact match
  for (const opt of options) {
    if (normalize(opt.text) === search && opt.value && opt.value !== '0') return opt.value;
  }
  // Contains match
  for (const opt of options) {
    if (normalize(opt.text).includes(search) && opt.value && opt.value !== '0') return opt.value;
  }
  // Reverse contains
  for (const opt of options) {
    if (opt.text.length > 2 && search.includes(normalize(opt.text)) && opt.value && opt.value !== '0') return opt.value;
  }
  // Word match (require word length > 3 to avoid false positives)
  const searchWords = search.split(/\s+/).filter(w => w.length > 3);
  for (const opt of options) {
    const optWords = normalize(opt.text).split(/\s+/);
    const hasMatch = searchWords.some(sw => optWords.some(ow => ow === sw));
    if (hasMatch && opt.value && opt.value !== '0') return opt.value;
  }
  return null;
}

/**
 * Find best barrio match in DAC dropdown using detected barrio name.
 */
async function findBarrioMatch(
  page: Page,
  selector: string,
  detectedBarrio: string
): Promise<string | null> {
  const options = await page.$$eval(
    `${selector} option`,
    (opts: any[]) => opts.map((o: any) => ({ value: o.value, text: o.textContent?.trim() ?? '' }))
  );

  const search = normalize(detectedBarrio);
  if (!search) return null;

  // Exact match first
  for (const opt of options) {
    if (normalize(opt.text) === search && opt.value && opt.value !== '0' && opt.value !== '') return opt.value;
  }
  // Contains match
  for (const opt of options) {
    if (normalize(opt.text).includes(search) && opt.value && opt.value !== '0' && opt.value !== '') return opt.value;
  }
  // Reverse contains
  for (const opt of options) {
    if (search.includes(normalize(opt.text)) && opt.text.length > 3 && opt.value && opt.value !== '0' && opt.value !== '') return opt.value;
  }
  return null;
}

function cleanPhone(phone: string | undefined): string {
  if (!phone) return '099000000';
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.length >= 6 ? cleaned : '099000000';
}

/**
 * Click the visible "Siguiente" button using Playwright locator (real click).
 * Returns true if a visible button was found and clicked.
 */
async function clickSiguiente(page: Page, slog: StepLogger, stepLabel: string): Promise<boolean> {
  // Use Playwright locator to find VISIBLE "Siguiente" links
  const siguienteLocator = page.locator('a').filter({ hasText: 'Siguiente' }).filter({ has: page.locator(':visible') });

  // Fallback: try all matching anchors and click the first visible one
  const allLinks = page.locator('a');
  const count = await allLinks.count();

  for (let i = 0; i < count; i++) {
    const link = allLinks.nth(i);
    const text = await link.textContent().catch(() => '');
    if (!text || !text.toLowerCase().includes('siguiente')) continue;

    const isVisible = await link.isVisible().catch(() => false);
    if (!isVisible) continue;

    slog.info(stepLabel, `Clicking visible Siguiente button (index ${i})`, { text: text.trim() });
    await link.click({ timeout: 5000 });
    await page.waitForTimeout(1000);
    return true;
  }

  slog.warn(stepLabel, 'No visible Siguiente button found');
  return false;
}

/**
 * Safely fill an input field using Playwright locator (real interaction).
 */
async function safeFill(page: Page, selector: string, value: string, slog: StepLogger, step: string, label: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (!el) {
      slog.warn(step, `Field not found: ${label}`, { selector });
      return false;
    }
    // Clear and fill using Playwright's fill (triggers proper events)
    await page.fill(selector, value);
    slog.info(step, `Filled ${label}`, { selector, value: value.substring(0, 30) });
    return true;
  } catch (err) {
    slog.warn(step, `Failed to fill ${label}: ${(err as Error).message}`, { selector });
    return false;
  }
}

/**
 * Safely select an option in a dropdown using Playwright (real interaction).
 */
async function safeSelect(page: Page, selector: string, value: string, slog: StepLogger, step: string, label: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (!el) {
      slog.warn(step, `Select not found: ${label}`, { selector });
      return false;
    }
    await page.selectOption(selector, value);
    slog.info(step, `Selected ${label}`, { selector, value });
    return true;
  } catch (err) {
    slog.warn(step, `Failed to select ${label}: ${(err as Error).message}`, { selector });
    return false;
  }
}

/**
 * Optional address fields that Claude has pre-corrected for a YELLOW order.
 * When passed to createShipment(), the address resolution pipeline
 * (detectCityIntelligent + AI resolver) is skipped entirely.
 */
export interface AddressOverride {
  /** Cleaned street + number, with apt/floor markers moved to notes */
  address1?: string;
  /** Concatenated apt/floor markers and other delivery notes */
  notes?: string;
  /** Resolved DAC department name (must be in VALID_DEPARTMENTS) */
  department?: string;
  /** Resolved city for the department dropdown */
  city?: string;
  /** Override recipient name */
  recipientName?: string;
  /** Normalized phone number (digits only) */
  phone?: string;
}

/**
 * Pure function: applies the fields present in `override` to `current`,
 * returning a new object with overridden values. Fields absent (undefined)
 * in `override` keep their `current` values unchanged.
 *
 * Extracted from createShipment() to enable isolated unit testing without
 * a Playwright Page dependency.
 */
export function applyAddressOverride(
  override: AddressOverride,
  current: {
    resolvedDept: string;
    resolvedCity: string;
    fullAddress: string;
    extraObs: string;
    phone: string;
    recipientName: string;
  },
): {
  resolvedDept: string;
  resolvedCity: string;
  fullAddress: string;
  extraObs: string;
  phone: string;
  recipientName: string;
} {
  return {
    resolvedDept: override.department ?? current.resolvedDept,
    resolvedCity: override.city ?? current.resolvedCity,
    fullAddress: override.address1 ?? current.fullAddress,
    extraObs: override.notes ?? current.extraObs,
    phone: override.phone ?? current.phone,
    recipientName: override.recipientName ?? current.recipientName,
  };
}

/**
 * Creates a shipment in DAC via Playwright browser automation.
 *
 * BUG FIXES applied:
 *   1. Phone field uses TelD (not TelefonoD)
 *   2. Uses real Playwright clicks for Siguiente/Agregar (not page.evaluate force-clicks)
 *   3. Submit via .btnAdd click after proper step navigation (not direct POST)
 *   4. Guia regex only matches numbers starting with 88 and 12+ digits
 *   5. Ultra-detailed step logging to console + DB
 */
/**
 * Detects whether the customer requested PICKUP AT A DAC BRANCH instead of
 * home delivery. The DAC submission form has a separate flow for this
 * (TipoEntrega=Agencia, no address1+number required). Examples that match:
 *
 *   - "Retiro en agencia" / "retiro en sucursal" / "retiro en DAC"
 *   - "Retiro" (as the whole address1)
 *   - "DAC Barros Blancos" / "Dac Las Piedras" (address1 starts with "DAC <city>")
 *   - "Sucursal de Dac Buceo" / "Sucursal Dac X"
 *   - "Pickup" anywhere in note
 *
 * Exported so unit tests can pin the recognition surface.
 */
export function isPickupAtDacBranch(
  address1: string | null | undefined,
  address2: string | null | undefined,
  orderNote: string | null | undefined,
): boolean {
  const a1 = (address1 ?? '').trim();
  const combined = `${a1} ${address2 ?? ''} ${orderNote ?? ''}`.toLowerCase();
  return (
    /retiro\s+(en\s+)?(dac|agencia|sucursal|local|oficina)/i.test(combined) ||
    /^retiro\b/i.test(a1) ||
    /\bsucursal\s+(de\s+)?dac\b/i.test(combined) ||
    /^\s*dac\s+\S/i.test(a1) || // "DAC Barros Blancos", "Dac Las Piedras"
    /\bpickup\b/i.test(combined)
  );
}

export async function createShipment(
  page: Page,
  order: ShopifyOrder,
  paymentType: 'REMITENTE' | 'DESTINATARIO',
  dacUsername: string,
  dacPassword: string,
  tenantId: string,
  jobId?: string,
  usedGuias?: Set<string>,
  addressOverride?: AddressOverride,
  autoPay?: AutoPayConfig
): Promise<DacShipmentResult> {
  const slog = createStepLogger(jobId ?? 'manual', tenantId);
  const addr = order.shipping_address;
  // 2026-05-11 — note appended to DAC observations when we ship an order
  // with no street number per operator directive. Injected into the
  // observations array at the step-4 fill site below.
  let noNumberOperatorNote: string | null = null;

  if (!addr || !addr.address1) {
    throw new Error(`Order ${order.name} has no shipping address`);
  }

  // ── ADDRESS-QUALITY PREPROCESSING (audit 2026-05-06) ──
  //
  // Customer-typed Shopify addresses sometimes have structural issues
  // that DAC's silent validator rejects WITHOUT showing an error
  // message. The form click "succeeds" (URL stays on /envios/nuevo,
  // error box empty) but no guía is created. The downstream rescue
  // path can't recover what doesn't exist.
  //
  // Production cases this preprocessor addresses:
  //   #11733 Silvia Aranda  — "Asencio1666"      → "Asencio 1666"
  //   #11724 Marcela Pascal — "La Paloma"        → no number → fail fast
  //   #11705 Valeria Ramírez — "Parque batalle"  → "Parque Batlle"
  //   #11748 naza fernandez  — city="San José"   → "San Jose de Mayo"
  //
  // We mutate `addr` in place so all downstream code (mergeAddress,
  // resolver, DAC form fill, AI fallback, Label upsert) sees the
  // cleaned values transparently. Originals are logged for audit.
  {
    // (1) Normalize address1: insert space between letter+digit pairs
    //     ("Asencio1666" → "Asencio 1666"). Idempotent.
    const originalAddress1 = addr.address1;
    const prep = preprocessShopifyAddress(addr.address1);
    if (prep.wasNormalized) {
      addr.address1 = prep.cleanedAddress1;
      slog.info(
        DAC_STEPS.PREPROCESS_ADDRESS,
        `Address1 normalized (street/number spacing): "${originalAddress1}" → "${addr.address1}"`,
        { before: originalAddress1, after: addr.address1, audit: '2026-05-06' },
      );
    }

    // (2) Address1 has NO digit anywhere — DAC requires a numeric street
    //     number to create a guía. BUT before bouncing to the operator,
    //     give Claude Haiku a second opinion: maybe the number is hiding
    //     in address2 / order.notes and AI can extract it, or maybe the
    //     order really IS too broken and we should mark it as such with
    //     a specific operator question.
    //
    //     Audit 2026-05-06 — design rationale:
    //       Customer data is messier than what regex can catch. AI sees
    //       the full order context (city, address1, address2, notes,
    //       customer name/email/phone) and decides whether the address
    //       is recoverable. Cost ~$0.001 per call, called only on stuck
    //       orders, total ~$0.02/day.
    if (prep.missingStreetNumber) {
      // 2026-05-11 operator directive — two behavior changes vs the prior
      // "always bounce when AI says not shippable" path:
      //
      //   (a) PICKUP AT DAC BRANCH ("Retiro en agencia", "DAC Barros Blancos",
      //       "Sucursal de Dac X", etc.) → skip the AI feasibility call entirely
      //       and let the order flow through. The DAC submission code further
      //       down detects the pickup pattern and uses TipoEntrega=Agencia,
      //       which does NOT require a street number.
      //
      //   (b) ALL OTHER NO-NUMBER ADDRESSES → ship anyway with an operator
      //       note ("CONTACTAR POR TELEFONO PARA NUMERO DE PUERTA") in the
      //       DAC observations field. The DAC operator calls the customer
      //       to get the missing number before physical delivery. We still
      //       give AI one shot to RECOVER the number from address2/notes
      //       (preserves the existing "AI found the number" happy path) —
      //       only when AI can't recover do we fall through to the
      //       ship-with-note flow that replaces the previous bounce.
      //
      // Trade-off the operator explicitly accepted on 2026-05-11: some
      // genuinely broken addresses (e.g. "La Paloma" alone) may now get
      // silently rejected by DAC and end up as orphan PendingShipments
      // (caught by the C-4 guard). Net behavior: more orders attempted,
      // a few more silent rejects, far fewer "needs operator review"
      // pile-ups for addresses that DAC operators can handle.

      if (isPickupAtDacBranch(addr.address1, addr.address2, order.note)) {
        slog.info(
          DAC_STEPS.PREPROCESS_ADDRESS,
          `Pickup-at-agency pattern detected ("${addr.address1}") — skipping AI feasibility; DAC submission will use TipoEntrega=Agencia`,
          { orderName: order.name, address1: addr.address1, audit: '2026-05-11' },
        );
        // Continue through the normal flow. The block at line ~1611 detects
        // the same pattern and switches the DAC form into pickup mode.
      } else {
        slog.info(
          DAC_STEPS.PREPROCESS_ADDRESS,
          `Address1 has no street number — invoking AI feasibility to try to recover the number from address2/notes (will ship-with-note if AI cannot recover, per 2026-05-11 directive)`,
          { orderName: order.name, address1: addr.address1, audit: '2026-05-11' },
        );
        const recipientName =
          `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente';
        const verdict = await assessAddressFeasibility({
          reason: 'no-street-number',
          tenantId,
          orderName: order.name,
          customerName: recipientName,
          customerEmail: order.email ?? undefined,
          customerPhone: addr.phone ?? undefined,
          orderNotes: order.note ?? undefined,
          city: addr.city ?? undefined,
          address1: addr.address1,
          address2: addr.address2 ?? undefined,
          zip: addr.zip ?? undefined,
          province: addr.province ?? undefined,
          country: addr.country ?? undefined,
          // Validate AI's suggestedCity against the customer's province
          // dropdown — if that's a recognized UY dept name. Falls back
          // to "all 19 depts" inside assessAddressFeasibility otherwise.
          targetDepartment: addr.province ?? undefined,
        });

        if (verdict.shippable && verdict.suggestedAddress1 && /\d/.test(verdict.suggestedAddress1)) {
          // AI recovered a usable address (e.g. found a number in address2
          // or notes). Apply the repair and continue through the normal flow.
          // This is the existing happy path, preserved bit-for-bit.
          const beforeRepair = addr.address1;
          addr.address1 = verdict.suggestedAddress1;
          slog.info(
            DAC_STEPS.PREPROCESS_ADDRESS,
            `AI recovered missing street number: "${beforeRepair}" → "${addr.address1}" (confidence=${verdict.confidence})`,
            {
              before: beforeRepair,
              after: addr.address1,
              aiConfidence: verdict.confidence,
              aiReasoning: verdict.reasoning,
              aiCostUsd: verdict.aiCostUsd,
              audit: '2026-05-11',
            },
          );
        } else {
          // AI couldn't recover the number. 2026-05-11 directive: ship anyway
          // with a note for the DAC operator (was: bounce as NEEDS_REVIEW).
          // Mark address1 with "S/N" if it doesn't already carry that marker,
          // so DAC's number field has something to display.
          if (!/\bs\/n\b|sin\s+n[uú]mero/i.test(addr.address1)) {
            addr.address1 = addr.address1.trim() + ' S/N';
          }
          // 2026-05-12 operator update — include the customer's phone in the
          // note so the DAC delivery person can call directly without
          // looking up the order. Also include the customer name for
          // operator clarity. Falls back to a generic message when phone
          // is missing (rare but possible).
          const phoneForNote = (addr.phone ?? '').trim();
          const recipientForNote = `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim();
          noNumberOperatorNote = phoneForNote
            ? `FALTA DATO EN DIRECCION — CONTACTAR AL CLIENTE ${recipientForNote || ''} TEL ${phoneForNote} PARA CONFIRMAR DATOS COMPLETOS`.replace(/\s+/g, ' ').trim()
            : 'FALTA DATO EN DIRECCION — CONTACTAR AL CLIENTE PARA CONFIRMAR DATOS COMPLETOS (sin telefono en la orden)';
          slog.warn(
            DAC_STEPS.PREPROCESS_ADDRESS,
            `No street number recovered — shipping anyway with operator-call note in DAC observations (replaces prior bounce per 2026-05-11 directive). AI reasoning: ${verdict.reasoning ?? '(no reasoning)'}`,
            {
              orderName: order.name,
              addressWithSn: addr.address1,
              aiReasoning: verdict.reasoning,
              aiConfidence: verdict.confidence,
              aiCostUsd: verdict.aiCostUsd,
              audit: '2026-05-11',
            },
          );
        }
      }
    }

    // (2.5) Hyphen-joined "City-Department" form (e.g. "Dolores-Soriano",
    //       "Cardona-Soriano"). When the customer's checkout lacked a
    //       separate dept dropdown and they typed both into the city
    //       field, extract just the city. Runs BEFORE fuzzy match so
    //       the cleaned city has a chance to exact-match in step 3.
    if (addr.city) {
      const splitCity = splitHyphenatedCityName(addr.city);
      if (splitCity !== addr.city) {
        const originalCity = addr.city;
        addr.city = splitCity;
        slog.info(
          DAC_STEPS.PREPROCESS_ADDRESS,
          `Hyphenated city split: "${originalCity}" → "${addr.city}"`,
          { before: originalCity, after: addr.city, audit: '2026-05-06' },
        );
      }
    }

    // (3) Fuzzy city typo correction. Searches CITY_TO_DEPARTMENT for
    //     a canonical key within edit-distance 1 of the typed city.
    //     Skips when the typed city already resolves to an exact match
    //     after accent/case normalization (avoids "fixing" "San José"
    //     → "San Jose" on accents alone).
    if (addr.city) {
      const cityNormalized = addr.city
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const fuzzy = fuzzyMatchCity(addr.city, 1);
      if (fuzzy && fuzzy !== cityNormalized) {
        const originalCity = addr.city;
        // Title-case the canonical key for DAC dropdown matching
        addr.city = fuzzy.replace(/\b\w/g, (c) => c.toUpperCase());
        slog.info(
          DAC_STEPS.PREPROCESS_ADDRESS,
          `City typo corrected: "${originalCity}" → "${addr.city}" (Levenshtein dist 1)`,
          { before: originalCity, after: addr.city, audit: '2026-05-06' },
        );
      }
    }

    // (4) When customer typed the DEPARTMENT name as the city
    //     (e.g. city="San José", province="San José") and the
    //     department's capital is a DIFFERENT name (e.g. "San José
    //     de Mayo"), substitute. DAC's city dropdown for that dept
    //     doesn't have an option matching the dept name.
    const correctedCity = correctCityWhenEqualsDepartment(addr.city, addr.province);
    if (correctedCity && correctedCity !== addr.city) {
      const originalCity = addr.city;
      addr.city = correctedCity;
      slog.info(
        DAC_STEPS.PREPROCESS_ADDRESS,
        `City equals department — substituted with capital: "${originalCity}" → "${addr.city}" (dept: ${addr.province})`,
        { before: originalCity, after: addr.city, dept: addr.province, audit: '2026-05-06' },
      );
    }
  }

  // C-4 (2026-04-21 audit): refuse to re-enter the DAC form if a prior
  // submit attempt for this exact (tenant, order) has a PendingShipment
  // row. That row is written pre-click, so its existence means either a
  // previous submit succeeded (RESOLVED — Label should already have the
  // guía), or a previous submit clicked Finalizar and we don't know if a
  // guía was created (PENDING/ORPHANED — needs operator reconcile).
  // Re-entering the form in either case risks a duplicate DAC shipment.
  await assertNoPriorSubmit(tenantId, String(order.id), slog);

  // ── AI ADDRESS VALIDATOR (2026-05-11) ──────────────────────────────
  //
  // Two production silent rejects today (#12001 Esmeralda P + #12002 Liria
  // Pouso) had internally inconsistent (city, province, zip) tuples — DAC's
  // server-side validator rejected without showing an error. The
  // deterministic city→dept resolver returned HIGH confidence so neither
  // ai-feasibility nor ai-resolver fired, and the bad address went
  // straight to DAC.
  //
  // The validator below runs PROACTIVELY before every DAC submit (vs the
  // existing ai-feasibility / ai-resolver which fire reactively on
  // specific triggers). It uses the Mac Mini bridge (Claude Max, $0)
  // when available, falls back to the Anthropic API otherwise. NEVER
  // throws — on any error returns `skipped` and we proceed with the
  // original address. Only HIGH-CONFIDENCE corrections are auto-applied;
  // medium/low get logged for operator visibility but don't mutate addr.
  //
  // Scope of corrections (validator self-restricted):
  //   • department / province  — yes (e.g. "Pando + MVD" → "Pando + Canelones")
  //   • ZIP code               — yes (e.g. Pando + 15600 → 91000)
  //   • city, address1, names  — NEVER. Preserving the customer's typed
  //     identity fields keeps the audit trail clean and avoids
  //     "the customer typed X but the label says Y" complaints.
  let addressAutoCorrectionNote: string | null = null;
  try {
    const validation = await validateAddressConsistency({
      tenantId,
      orderName: order.name,
      address1: addr.address1,
      address2: addr.address2 ?? undefined,
      city: addr.city ?? undefined,
      province: addr.province ?? undefined,
      zip: addr.zip ?? undefined,
      country: addr.country ?? 'Uruguay',
    });
    if (!validation.skipped && !validation.consistent && validation.corrections) {
      if (validation.confidence === 'high') {
        const before = {
          province: addr.province ?? '',
          zip: addr.zip ?? '',
        };
        const changes: string[] = [];
        if (validation.corrections.department && validation.corrections.department !== before.province) {
          addr.province = validation.corrections.department;
          changes.push(`province ${before.province || '∅'}→${validation.corrections.department}`);
        }
        if (validation.corrections.zip && validation.corrections.zip !== before.zip) {
          addr.zip = validation.corrections.zip;
          changes.push(`zip ${before.zip || '∅'}→${validation.corrections.zip}`);
        }
        if (changes.length > 0) {
          // 2026-05-11 — concise note for the DAC printed label. Operator
          // request: keep observations short so they fit on the sticker.
          // Verbose motivos / Claude's reasoning still go to slog + RunLog
          // for audit, but NOT to the DAC observations field.
          addressAutoCorrectionNote = `AI corrigió: ${changes.join(', ')}`;
          slog.info(
            DAC_STEPS.PREPROCESS_ADDRESS,
            `Address auto-corrected by AI validator (high confidence): ${changes.join(', ')}`,
            {
              orderName: order.name,
              changes,
              issues: validation.issues, // kept in audit log, not on label
              transport: validation.transport,
              aiCostUsd: validation.aiCostUsd,
              audit: '2026-05-11',
            },
          );
        }
      } else {
        // Medium/low confidence — flag for visibility but don't mutate.
        // The address proceeds as-is; if DAC rejects, the rescue + operator
        // note path will surface the issues for manual review.
        slog.warn(
          DAC_STEPS.PREPROCESS_ADDRESS,
          `AI validator flagged inconsistencies (confidence=${validation.confidence}, NOT auto-applying): ${validation.issues.join('; ')}`,
          {
            orderName: order.name,
            issues: validation.issues,
            suggestedCorrections: validation.corrections,
            transport: validation.transport,
            confidence: validation.confidence,
            audit: '2026-05-11',
          },
        );
      }
    }
  } catch (validatorErr) {
    // Defense-in-depth — validator is documented to never throw, but if it
    // somehow does, the order still ships with the original address.
    slog.info(
      DAC_STEPS.PREPROCESS_ADDRESS,
      `Address validator failed unexpectedly — proceeding with original address: ${(validatorErr as Error).message}`,
      { orderName: order.name },
    );
  }

  await ensureLoggedIn(page, dacUsername, dacPassword, tenantId);

  slog.info(DAC_STEPS.NAV_NEW_SHIPMENT, `Navigating to new shipment form for ${order.name}`, {
    orderName: order.name,
    paymentType,
    city: addr.city,
    province: addr.province,
  });

  // Navigate to new shipment form
  await page.goto(DAC_URLS.NEW_SHIPMENT, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForTimeout(2000);

  // Wait for the form to be present
  try {
    await page.waitForSelector('select[name="TipoServicio"]', { timeout: 8_000 });
    slog.info(DAC_STEPS.NAV_FORM_LOADED, 'Shipment form loaded, TipoServicio visible');
  } catch {
    await dacBrowser.screenshot(page, `form-not-loaded-${order.name.replace('#', '')}`);
    throw new Error('DAC shipment form did not load (TipoServicio not found)');
  }

  // ===== DETECT RETIRO EN AGENCIA =====
  // If the customer wrote "retiro en DAC" / "retiro en agencia" / "retiro en sucursal" /
  // "DAC <ciudad>" / "Sucursal de Dac X" / "pickup" anywhere in the address fields
  // or order note, this is a pickup at DAC branch — not home delivery.
  // 2026-05-11 — recognition broadened (was a 3-regex inline check that missed
  // "Sucursal de Dac Buceo" and "DAC Barros Blancos"). The shared
  // isPickupAtDacBranch() helper covers all the variants and is unit-tested.
  const isRetiroEnAgencia = isPickupAtDacBranch(addr.address1, addr.address2, order.note);

  if (isRetiroEnAgencia) {
    slog.info(DAC_STEPS.STEP1_START, `RETIRO EN AGENCIA detected — address: "${addr.address1}", will use TipoEntrega=Agencia`);
  }

  // ===== STEP 1: Shipment Type =====
  slog.info(DAC_STEPS.STEP1_START, 'Filling Step 1: shipment type fields');

  const pickupVal = DAC_SELECTORS.PICKUP_VALUE_MOSTRADOR;
  const payVal = paymentType === 'REMITENTE'
    ? DAC_SELECTORS.PAYMENT_VALUE_REMITENTE
    : DAC_SELECTORS.PAYMENT_VALUE_DESTINATARIO;
  const packageVal = DAC_SELECTORS.PACKAGE_VALUE_PAQUETE;
  const deliveryVal = isRetiroEnAgencia
    ? DAC_SELECTORS.DELIVERY_VALUE_AGENCIA
    : DAC_SELECTORS.DELIVERY_VALUE_DOMICILIO;

  await safeSelect(page, 'select[name="TipoServicio"]', pickupVal, slog, DAC_STEPS.STEP1_TIPO_SERVICIO, 'TipoServicio');
  await page.waitForTimeout(300);

  // TipoGuia might be a select or hidden input
  const tipoGuiaEl = await page.$('select[name="TipoGuia"]');
  if (tipoGuiaEl) {
    await safeSelect(page, 'select[name="TipoGuia"]', payVal, slog, DAC_STEPS.STEP1_TIPO_GUIA, 'TipoGuia');
  } else {
    // Set hidden input value via evaluate
    await page.evaluate((val: string) => {
      const el = document.querySelector('[name="TipoGuia"]') as HTMLInputElement;
      if (el) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, payVal);
    slog.info(DAC_STEPS.STEP1_TIPO_GUIA, 'Set TipoGuia (hidden input)', { value: payVal });
  }

  await safeSelect(page, 'select[name="TipoEnvio"]', packageVal, slog, DAC_STEPS.STEP1_TIPO_ENVIO, 'TipoEnvio');
  await page.waitForTimeout(300);
  await safeSelect(page, 'select[name="TipoEntrega"]', deliveryVal, slog, DAC_STEPS.STEP1_TIPO_ENTREGA, 'TipoEntrega');
  await page.waitForTimeout(300);

  slog.info(DAC_STEPS.STEP1_OK, 'Step 1 complete', { pickupVal, payVal, packageVal, deliveryVal });

  // Click Siguiente to advance from Step 1 to Step 2
  await dacBrowser.screenshot(page, `step1-complete-${order.name.replace('#', '')}`);
  const adv1 = await clickSiguiente(page, slog, DAC_STEPS.STEP1_SIGUIENTE);
  if (!adv1) {
    slog.warn(DAC_STEPS.STEP1_SIGUIENTE, 'Could not click Siguiente after Step 1, continuing anyway');
  }
  await page.waitForTimeout(800);

  // ===== STEP 2: Origin (auto-filled) =====
  slog.info(DAC_STEPS.STEP2_START, 'Step 2: Origin (auto-filled from account)');
  await dacBrowser.screenshot(page, `step2-before-${order.name.replace('#', '')}`);

  const adv2 = await clickSiguiente(page, slog, DAC_STEPS.STEP2_SIGUIENTE);
  if (!adv2) {
    slog.warn(DAC_STEPS.STEP2_SIGUIENTE, 'Could not click Siguiente after Step 2, continuing anyway');
  }
  await page.waitForTimeout(1000);
  slog.info(DAC_STEPS.STEP2_OK, 'Step 2 complete');

  // ===== STEP 3: Recipient =====
  slog.info(DAC_STEPS.STEP3_START, 'Filling Step 3: recipient data');
  await dacBrowser.screenshot(page, `step3-before-${order.name.replace('#', '')}`);

  // ── RECIPIENT NAME — short-last-name auto-recovery (2026-05-11) ──
  //
  // Incident #12001 Esmeralda P: Shopify name = "Esmeralda P" (single-letter
  // last name from incomplete checkout). DAC server-side validator silently
  // rejected — no error in the form, URL stayed on /envios/nuevo, rescue
  // exhausted, order parqueado.
  //
  // Root cause confirmed by querying historic Labels: in the tenant's
  // entire history, ALL successful Aires Puros orders had multi-word
  // names; #12001 was the ONLY single-letter-last-name order ever, and
  // it failed. DAC rejects names below a (~undocumented) minimum length.
  //
  // Recovery: try to infer the missing last name from the customer's
  // email handle. The function is DETERMINISTIC (no AI, no hallucination
  // surface) — it only returns a candidate when the firstName appears
  // verbatim in the email handle and there's a ≥3-char alphabetic
  // remainder. Otherwise returns null and we ship with the original
  // (likely short) name, letting DAC's reject or accept decide.
  //
  // Example: "pieriesmeralda@gmail.com" + firstName "Esmeralda" + lastName "P"
  //   → handle "pieriesmeralda" contains "esmeralda" at idx=5
  //   → remainder "pieri" (5 alpha chars) → inferred last name = "Pieri"
  //   → submit DAC with name "Esmeralda Pieri" + observation note about
  //     the AI-recovered last name (audit trail for operator).
  const rawFirstName = (addr.first_name ?? '').trim();
  const rawLastName = (addr.last_name ?? '').trim();
  let lastNameInferenceNote: string | null = null;
  let effectiveLastName = rawLastName;

  if (rawLastName.length <= 2 && rawFirstName.length > 0) {
    const inference = inferLastNameFromEmail({
      firstName: rawFirstName,
      lastName: rawLastName,
      email: order.email ?? addr.phone ?? '',
    });
    if (inference.inferredLastName) {
      effectiveLastName = inference.inferredLastName;
      lastNameInferenceNote = `AI corrigió apellido: "${rawLastName || '∅'}" → "${inference.inferredLastName}" (inferido del email)`;
      slog.info(
        DAC_STEPS.STEP3_FILL_NAME,
        `Short last name recovered from email: "${rawLastName}" → "${inference.inferredLastName}"`,
        {
          orderName: order.name,
          originalLastName: rawLastName,
          inferredLastName: inference.inferredLastName,
          reasoning: inference.reasoning,
          audit: '2026-05-11',
        },
      );
    } else {
      slog.warn(
        DAC_STEPS.STEP3_FILL_NAME,
        `Short last name "${rawLastName}" but no inference possible — submitting as-is, may trigger DAC silent reject. ${inference.reasoning}`,
        {
          orderName: order.name,
          originalLastName: rawLastName,
          reasoning: inference.reasoning,
          audit: '2026-05-11',
        },
      );
    }
  }

  const fullName = addressOverride?.recipientName
    ?? (`${rawFirstName} ${effectiveLastName}`.trim() || 'Cliente');
  const phone = addressOverride?.phone ?? cleanPhone(addr.phone);

  // BUG FIX 5 (NAME CROSS-ASSIGNMENT): Clear ALL recipient fields BEFORE filling
  // This prevents stale data from previous order leaking into current one
  await page.evaluate(() => {
    const fields = ['NombreD', 'TelD', 'DirD', 'Correo_Destinatario', 'EmailD', 'telefono'];
    for (const name of fields) {
      const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement;
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  });
  slog.info(DAC_STEPS.STEP3_START, 'Cleared all recipient fields before filling new data');

  // Fill name — MUST succeed, throw if it doesn't (prevents wrong name)
  const nameFilled = await safeFill(page, 'input[name="NombreD"]', fullName, slog, DAC_STEPS.STEP3_FILL_NAME, 'NombreD (name)');
  if (!nameFilled) {
    throw new Error(`CRITICAL: Could not fill NombreD for order ${order.name} — aborting to prevent wrong name`);
  }
  // Verify the name was actually written correctly
  const nameVerify = await page.$eval('input[name="NombreD"]', (el: any) => el.value).catch(() => '');
  if (nameVerify !== fullName) {
    slog.warn(DAC_STEPS.STEP3_FILL_NAME, `Name verification mismatch! Expected "${fullName}", got "${nameVerify}" — refilling`);
    await page.fill('input[name="NombreD"]', '');
    await page.fill('input[name="NombreD"]', fullName);
  }

  // TelD is the correct phone field name
  const phoneFilled = await safeFill(page, 'input[name="TelD"]', phone, slog, DAC_STEPS.STEP3_FILL_PHONE, 'TelD (phone)');
  if (!phoneFilled) {
    slog.warn(DAC_STEPS.STEP3_FILL_PHONE, 'TelD not found, trying fallback selectors');
    await safeFill(page, 'input[name="telefono"]', phone, slog, DAC_STEPS.STEP3_FILL_PHONE, 'telefono (fallback)');
  }

  // Email (optional)
  if (order.email) {
    const emailFilled = await safeFill(page, 'input[name="Correo_Destinatario"]', order.email, slog, DAC_STEPS.STEP3_FILL_EMAIL, 'Correo_Destinatario');
    if (!emailFilled) {
      await safeFill(page, 'input[name="EmailD"]', order.email, slog, DAC_STEPS.STEP3_FILL_EMAIL, 'EmailD (fallback)');
    }
  }

  // BUG FIX 2+3 (ADDRESS): Merge address1 + address2 into single delivery address
  // This ensures door numbers, apt info, and "Centro" are in the address field, not observations
  let { fullAddress, extraObs } = mergeAddress(addr.address1, addr.address2);

  // Post-merge: detect slash pattern "3274/801" in final address → extract apt to observations
  const slashMatch = /(\d+)\s*\/\s*(\d+)\s*$/.exec(fullAddress);
  if (slashMatch && !extraObs) {
    extraObs = `Apto ${slashMatch[2]}`;
    slog.info(DAC_STEPS.STEP3_FILL_ADDRESS, `Detected slash apt pattern: "${slashMatch[0]}" → obs: "${extraObs}"`);
  }
  slog.info(DAC_STEPS.STEP3_FILL_ADDRESS, `Merged address: "${fullAddress}"`, {
    address1: addr.address1, address2: addr.address2 ?? '', extraObs,
  });

  const addrFilled = await safeFill(page, 'input[name="DirD"]', fullAddress, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD (address)');
  if (!addrFilled) {
    await safeFill(page, '#DirD', fullAddress, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD by id (fallback)');
  }

  // ── CROSS-VALIDATION: Resolve correct department from city using Uruguay geo DB ──
  // Shopify customers often put wrong department or use barrio as city.
  // We trust the CITY name and look up the real department from our geo database.
  let resolvedDept = addr.province ?? '';
  let resolvedCity = addr.city ?? '';
  let resolvedBarrioHint: string | null = null;

  // Run intelligent city detection using ZIP, street, and alias strategies
  const intelligent = detectCityIntelligent(
    addr.city ?? '', addr.address1, addr.address2 ?? '', addr.zip ?? ''
  );
  slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
    `Intelligent detection: barrio="${intelligent.barrio ?? 'none'}" dept="${intelligent.department ?? 'none'}" source=${intelligent.source} confidence=${intelligent.confidence}`,
    { zip: addr.zip, city: addr.city, address1: addr.address1 }
  );

  let aiResolution: AIResolverResult | null = null;

  if (addressOverride) {
    // Address was pre-corrected by Claude — skip AI + deterministic resolution entirely
    const applied = applyAddressOverride(addressOverride, {
      resolvedDept,
      resolvedCity,
      fullAddress,
      extraObs,
      phone,
      recipientName: fullName,
    });
    resolvedDept = applied.resolvedDept;
    resolvedCity = applied.resolvedCity;
    extraObs = applied.extraObs;
    if (addressOverride.address1 !== undefined) {
      fullAddress = applied.fullAddress;
      await safeFill(page, 'input[name="DirD"]', fullAddress, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD (override refill)');
    }
    slog.info(DAC_STEPS.STEP3_SELECT_DEPT, 'Address override applied — skipping deterministic/AI resolution', {
      fullAddress, resolvedDept, resolvedCity, extraObs: extraObs || 'none',
    });
  } else {
  // ── AI FALLBACK ──
  // When deterministic rules cannot resolve the address with high confidence,
  // ask Claude Haiku to resolve it using structured tool use. The AI result
  // overrides the deterministic result for dept/city/barrio/address/obs.
  // See apps/worker/src/dac/ai-resolver.ts for the full implementation.
  if (shouldInvokeAIResolver(intelligent)) {
    slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
      `Deterministic confidence ${intelligent.confidence} — invoking AI resolver fallback`,
      { city: addr.city, address1: addr.address1, zip: addr.zip }
    );
    try {
      aiResolution = await resolveAddressWithAI({
        tenantId,
        city: addr.city ?? '',
        address1: addr.address1,
        address2: addr.address2 ?? '',
        zip: addr.zip ?? '',
        province: addr.province ?? '',
        orderNotes: order.note ?? '',
        // Phase-1 enrichment (2026-04-21): customer identity + country. These
        // let the AI look up prior successful shipments and use phone/landline
        // prefixes + country defense as additional disambiguation signals.
        customerEmail: order.email ?? '',
        customerPhone: addr.phone ?? '',
        customerFirstName: addr.first_name ?? '',
        customerLastName: addr.last_name ?? '',
        country: addr.country ?? '',
        // Phase-2 enrichment (audit 2026-05-07): pass the deterministic
        // resolver's barrio guess to AI as a HINT. Lets Claude confirm
        // from training data without invoking web_search when our guess
        // is plausible. Saves ~$0.02/call when AI accepts the hint.
        intelligentBarrioHint: intelligent.barrio ?? undefined,
        intelligentConfidence: intelligent.confidence,
        intelligentSource: intelligent.source,
      });
      if (aiResolution) {
        slog.success(DAC_STEPS.STEP3_SELECT_DEPT,
          `AI resolved: dept="${aiResolution.department}" city="${aiResolution.city}" barrio="${aiResolution.barrio ?? 'none'}" confidence=${aiResolution.confidence} source=${aiResolution.source}`,
          { reasoning: aiResolution.reasoning, costUsd: aiResolution.aiCostUsd }
        );
        // Override the deterministic merged address with AI's cleaner version
        if (aiResolution.deliveryAddress && aiResolution.deliveryAddress.trim().length > 0) {
          fullAddress = aiResolution.deliveryAddress;
          // Merge AI extra obs with existing extraObs (from mergeAddress)
          if (aiResolution.extraObservations && aiResolution.extraObservations.trim().length > 0) {
            extraObs = extraObs
              ? `${extraObs} | ${aiResolution.extraObservations}`
              : aiResolution.extraObservations;
          }
          // Re-fill the address field with the AI-cleaned version
          await safeFill(page, 'input[name="DirD"]', fullAddress, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD (AI-cleaned)');
        }
      } else {
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          'AI resolver unavailable or returned null — falling back to deterministic rules'
        );
      }
    } catch (err) {
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
        `AI resolver threw — falling back to deterministic rules: ${(err as Error).message}`
      );
    }
  }

  // AI SHORT-CIRCUIT: If AI returned a high/medium confidence resolution, use it
  // directly instead of running the deterministic chain below. AI output is already
  // validated against department + barrio whitelists in ai-resolver.ts.
  if (aiResolution && (aiResolution.confidence === 'high' || aiResolution.confidence === 'medium')) {
    resolvedDept = aiResolution.department;
    resolvedCity = aiResolution.city;
    resolvedBarrioHint = aiResolution.barrio;
    slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
      `Using AI resolution directly: dept="${resolvedDept}" city="${resolvedCity}" barrio="${resolvedBarrioHint ?? 'none'}"`
    );
  } else if (addr.city) {
    const geoDept = await getDepartmentForCityAsync(addr.city);
    if (geoDept) {
      // City found in our geo DB. Decide whether to apply it as a correction
      // over the customer's Shopify province.
      //
      // Audit 2026-05-05 — AMBIGUOUS-CITY GUARD:
      //   If the geo lookup would flip a non-Montevideo Shopify province to
      //   Montevideo, AND the city name is generic (every UY town has a
      //   "Centro", "Cerro", "Bella Vista" etc.), AND the ZIP does NOT also
      //   say Montevideo, refuse to override the customer's stated province.
      //   The pre-fix behavior was misrouting interior orders to Montevideo:
      //     - #11616 Adriana Martinez — Tacuarembó / city="Centro"
      //     - #11015 — Rocha / city="Centro"
      //     - #11129 — Treinta y Tres / city="Centro"
      //     - #11673 Flavia Falero — Maldonado / city="Centro/San Carlos"
      //     - #1215  Ines Velazco — Maldonado / city="Bella Vista"
      //   See apps/worker/src/dac/uruguay-geo.ts AMBIGUOUS_CITY_NAMES.
      const wouldFlipToMvd = normalize(geoDept) === 'montevideo';
      const shopifyProvinceIsValidNonMvd =
        isValidUruguayProvince(addr.province) &&
        normalize(addr.province ?? '') !== 'montevideo';
      const cityIsAmbiguous = isAmbiguousCityName(addr.city);
      const zipDept = getDepartmentFromZip(addr.zip ?? '');
      const zipCorroboratesMvd = zipDept ? normalize(zipDept) === 'montevideo' : false;

      // 2026-05-12 — SYMMETRIC AMBIGUOUS-CITY GUARD (incident #12020 Elisa
      // Bordes). The original 2026-05-05 guard above only protected against
      // wrongly flipping TO Montevideo. But the inverse case is also a real
      // bug: "La Aguada" is BOTH a MVD barrio AND a small Rocha locality.
      // For #12020 the customer typed:
      //     city="La Aguada", province="Montevideo", zip="11800"
      // The intelligent detection correctly identified the MVD barrio
      // (source=alias, barrio="aguada"). Then getDepartmentForCityAsync
      // returned "Rocha" (the geo DB picks one when the city is ambiguous),
      // the !== check fired, and the GEO CORRECTION over-rode the MVD
      // verdict to Rocha. DAC silently rejected because La Aguada isn't a
      // valid city/barrio in DAC's Rocha dropdown.
      //
      // Fix: BEFORE applying the geo correction, check if BOTH signals
      // corroborate Montevideo:
      //   - Shopify province says Montevideo, AND
      //   - ZIP is in the MVD range (11xxx), AND
      //   - intelligent.barrio detected a MVD barrio (alias-matched)
      // In that case, trust Shopify+ZIP+intelligent over the city-lookup,
      // even when the city-lookup found a non-MVD match. This is the same
      // "trust the corroborating signals" pattern as the original guard,
      // just flipped direction.
      const wouldFlipAwayFromMvd = normalize(geoDept) !== 'montevideo';
      const shopifyProvinceIsMvd = normalize(addr.province ?? '') === 'montevideo';
      const intelligentSaysMvd = normalize(intelligent.department ?? '') === 'montevideo';

      if (wouldFlipAwayFromMvd && shopifyProvinceIsMvd && zipCorroboratesMvd && intelligentSaysMvd && intelligent.barrio) {
        // Shopify+ZIP+barrio-alias all agree MVD — refuse the city-lookup
        // override. The city name is ambiguous between dept and a MVD
        // barrio, and all corroborating signals point at MVD.
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          `GEO OVERRIDE BLOCKED (mvd-direction): city "${addr.city}" geo-resolves to "${geoDept}" but Shopify=Montevideo + ZIP=${addr.zip ?? '?'} + intelligent.barrio="${intelligent.barrio}" all say Montevideo — keeping Montevideo`,
          { ambiguousCity: addr.city, shopifyProvince: addr.province, zipDept: zipDept ?? null, geoSuggestion: geoDept, intelligentBarrio: intelligent.barrio, audit: '2026-05-12' }
        );
        resolvedDept = 'Montevideo';
      } else if (wouldFlipToMvd && shopifyProvinceIsValidNonMvd && cityIsAmbiguous && !zipCorroboratesMvd) {
        // Trust Shopify — refuse the geo override.
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          `GEO OVERRIDE BLOCKED: ambiguous city "${addr.city}" geo-resolves to Montevideo but Shopify says "${addr.province}" and ZIP "${addr.zip ?? '(none)'}" does not corroborate — keeping "${addr.province}"`,
          { ambiguousCity: addr.city, shopifyProvince: addr.province, zipDept: zipDept ?? null, geoSuggestion: geoDept, audit: '2026-05-05' }
        );
        resolvedDept = addr.province!;
      } else if (normalize(geoDept) !== normalize(resolvedDept)) {
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          `GEO CORRECTION: City "${addr.city}" belongs to "${geoDept}" but Shopify says "${addr.province}" — using "${geoDept}"`,
          { shopifyProvince: addr.province, correctedDept: geoDept, city: addr.city }
        );
        resolvedDept = geoDept;
      } else {
        slog.info(DAC_STEPS.STEP3_SELECT_DEPT, `GEO VERIFIED: City "${addr.city}" correctly in "${geoDept}"`);
      }
      // If THE FINAL resolved dept is Montevideo, normalize the CITY dropdown
      // selection to "Montevideo" and detect a barrio. This block uses
      // `resolvedDept` (post-guard) NOT `geoDept` — otherwise a blocked
      // override would still set resolvedCity to "Montevideo" and break the
      // DAC form for the customer's actual interior province.
      //
      // BEFORE 2026-04-22: resolvedCity was only normalized INSIDE the barrio
      // branch, so orders with an ambiguous ZIP (e.g. 11600 → buceo / malvin /
      // malvin norte) left resolvedCity as the raw alias ("Mvdo."), which
      // never matched the dropdown → city field empty → DAC rejected the form.
      // Regression: order #11492 (Adriana Abeijon, "Juan Ortíz 3315, Mvdo.").
      if (normalize(resolvedDept) === 'montevideo') {
        resolvedCity = 'Montevideo';
        const barrio = intelligent.barrio ?? detectBarrio(addr.city, addr.address1, addr.address2 ?? '');
        if (barrio) {
          resolvedBarrioHint = barrio;
          slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
            `City "${addr.city}" is in Montevideo, barrio="${barrio}" (source: ${intelligent.source}) — will use "Montevideo" as city`);
        } else {
          slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
            `City "${addr.city}" is in Montevideo, no deterministic barrio — will use "Montevideo" as city, barrio left for AI/manual fallback`);
        }
      }
    } else {
      // City not in geo DB — use intelligent detection
      if (intelligent.barrio) {
        let iDept = intelligent.department ?? 'Montevideo';

        // Audit 2026-05-05 — same AMBIGUOUS-BARRIO guard as above. The
        // intelligent path defaults to "Montevideo" when ZIP doesn't help,
        // which is wrong for interior customers whose address text happens
        // to contain a generic word like "Centro" or "Cerro" (matched as a
        // MVD barrio alias by detectBarrio). If Shopify says a valid non-MVD
        // department and the matched barrio name is in our ambiguity list,
        // refuse the Montevideo default.
        if (
          normalize(iDept) === 'montevideo' &&
          isValidUruguayProvince(addr.province) &&
          normalize(addr.province ?? '') !== 'montevideo' &&
          isAmbiguousCityName(intelligent.barrio)
        ) {
          slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
            `INTELLIGENT OVERRIDE BLOCKED: ambiguous barrio match "${intelligent.barrio}" defaults to Montevideo, but Shopify says "${addr.province}" — keeping "${addr.province}"`,
            { ambiguousBarrio: intelligent.barrio, shopifyProvince: addr.province, source: intelligent.source, audit: '2026-05-05' }
          );
          iDept = addr.province!;
          resolvedDept = iDept;
          // Don't set resolvedBarrioHint — the barrio match was a false positive
          // (it matched a MVD-barrio name, but the customer is in a different dept).
          resolvedCity = addr.city ?? iDept;
        } else {
          slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
            `City "${addr.city}" not in geo DB but intelligent detected barrio "${intelligent.barrio}" (source: ${intelligent.source}) — using ${iDept}`,
            { detectedBarrio: intelligent.barrio, source: intelligent.source }
          );
          resolvedDept = iDept;
          // For Montevideo, use "Montevideo" as city (barrio handles the rest).
          // For other departments, keep Shopify's city to try matching in the dropdown.
          resolvedCity = iDept === 'Montevideo' ? 'Montevideo' : (addr.city ?? iDept);
          resolvedBarrioHint = intelligent.barrio;
        }
      } else if (intelligent.department) {
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          `City "${addr.city}" not in geo DB, no barrio detected, but ZIP suggests dept "${intelligent.department}"`,
          { city: addr.city, province: addr.province, zipDept: intelligent.department }
        );
        resolvedDept = intelligent.department;
      } else {
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          `City "${addr.city}" not found in geo DB and no intelligent match — using Shopify province "${addr.province}" as-is`,
          { city: addr.city, province: addr.province, zip: addr.zip }
        );
      }
    }
  } else {
    // City is EMPTY — use intelligent detection to fill in what we can
    if (intelligent.barrio) {
      const iDept = intelligent.department ?? addr.province ?? 'Montevideo';
      resolvedDept = iDept;
      // For Montevideo, use "Montevideo" as city. For other depts, use dept name as city (capital).
      resolvedCity = iDept === 'Montevideo' ? 'Montevideo' : iDept;
      resolvedBarrioHint = intelligent.barrio;
      slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
        `City empty — intelligent detected barrio "${intelligent.barrio}" in "${resolvedDept}" (source: ${intelligent.source}, confidence: ${intelligent.confidence})`,
        { zip: addr.zip, address1: addr.address1 }
      );
    } else if (intelligent.department) {
      resolvedDept = intelligent.department;
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
        `City empty — no barrio detected, but ZIP suggests dept "${intelligent.department}"`,
        { zip: addr.zip, province: addr.province }
      );
    } else {
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
        `City empty and no intelligent detection possible — using Shopify province "${addr.province}" as-is`,
        { province: addr.province, zip: addr.zip }
      );
    }
  }
  } // end else (no addressOverride)

  // Department (select) — using resolved (possibly corrected) department
  if (resolvedDept) {
    slog.info(DAC_STEPS.STEP3_SELECT_DEPT, `Selecting department: ${resolvedDept}`);
    const deptMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_DEPARTMENT, resolvedDept);
    if (deptMatch) {
      await safeSelect(page, DAC_SELECTORS.RECIPIENT_DEPARTMENT, deptMatch, slog, DAC_STEPS.STEP3_SELECT_DEPT, 'K_Estado (department)');
      slog.info(DAC_STEPS.STEP3_WAIT_CITIES, 'Waiting for cities to load after department change');
      await page.waitForTimeout(1500);
    } else {
      // Log available options for debugging
      const deptOptions = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_DEPARTMENT} option`,
        (opts: any[]) => opts.filter(o => o.value && o.value !== '0').map((o: any) => o.textContent?.trim()).slice(0, 20));
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT, `No department match in DAC dropdown for: ${resolvedDept}`, { availableOptions: deptOptions });
    }
  }

  // City (select) — using resolved city (may differ from Shopify if barrio was detected)
  if (resolvedCity) {
    slog.info(DAC_STEPS.STEP3_SELECT_CITY, `Selecting city: ${resolvedCity}`);
    let cityMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, resolvedCity);

    // If resolved city didn't match and it differs from Shopify city, try the original
    if (!cityMatch && addr.city && normalize(addr.city) !== normalize(resolvedCity)) {
      slog.info(DAC_STEPS.STEP3_SELECT_CITY, `Resolved city "${resolvedCity}" not in dropdown, trying original Shopify city "${addr.city}"`);
      cityMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, addr.city);
    }

    if (cityMatch) {
      await safeSelect(page, DAC_SELECTORS.RECIPIENT_CITY, cityMatch, slog, DAC_STEPS.STEP3_SELECT_CITY, 'K_Ciudad (city)');
      await page.waitForTimeout(800);
    } else {
      // City not found in DAC dropdown for this department — try barrio fallback
      const detectedBarrio = resolvedBarrioHint ||
        (normalize(resolvedDept) === 'montevideo' ? detectBarrio(resolvedCity, addr.address1, addr.address2 ?? '') : null);
      if (detectedBarrio) {
        slog.info(DAC_STEPS.STEP3_SELECT_CITY, `City "${resolvedCity}" not in dropdown, detected barrio "${detectedBarrio}", trying "Montevideo"`);
        const mvdMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, 'Montevideo');
        if (mvdMatch) {
          await safeSelect(page, DAC_SELECTORS.RECIPIENT_CITY, mvdMatch, slog, DAC_STEPS.STEP3_SELECT_CITY, 'K_Ciudad (Montevideo fallback)');
          await page.waitForTimeout(800);
        }
      } else {
        const cityOptions = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_CITY} option`,
          (opts: any[]) => opts.filter(o => o.value && o.value !== '0').map((o: any) => o.textContent?.trim()).slice(0, 30));
        slog.warn(DAC_STEPS.STEP3_SELECT_CITY, `No city match for "${resolvedCity}" and no barrio detected — city field left empty`, {
          city: resolvedCity, province: resolvedDept, shopifyCity: addr.city, availableCities: cityOptions,
        });
      }
    }
  }

  // Barrio selection — use pre-computed intelligent result (ZIP + street + alias)
  const detectedBarrioName = resolvedBarrioHint ?? intelligent.barrio;
  try {
    const barrioEl = await page.$(DAC_SELECTORS.RECIPIENT_BARRIO);
    if (barrioEl) {
      await page.waitForTimeout(500); // Wait for barrio dropdown to populate after city
      if (detectedBarrioName) {
        // Try intelligent match
        const barrioMatch = await findBarrioMatch(page, DAC_SELECTORS.RECIPIENT_BARRIO, detectedBarrioName);
        if (barrioMatch) {
          await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, barrioMatch, slog, DAC_STEPS.STEP3_SELECT_BARRIO, `K_Barrio (${detectedBarrioName})`);
          slog.info(DAC_STEPS.STEP3_SELECT_BARRIO, `Barrio matched: "${detectedBarrioName}" (source: ${intelligent.source})`, { matchedValue: barrioMatch });
        } else {
          // Detected a barrio name but couldn't find it in dropdown — log available options for debugging
          const barrioOptions = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_BARRIO} option`,
            (opts: any[]) => opts.filter(o => o.value && o.value !== '0' && o.value !== '').map((o: any) => ({ value: o.value, text: o.textContent?.trim() })).slice(0, 30));
          slog.warn(DAC_STEPS.STEP3_SELECT_BARRIO, `Barrio "${detectedBarrioName}" detected (${intelligent.source}) but not in dropdown`, { availableBarrios: barrioOptions.map(b => b.text) });
          // Try partial match with first word of detected barrio (only if word is long enough to avoid false positives)
          const firstWord = normalize(detectedBarrioName).split(/\s+/)[0];
          const partialMatch = barrioOptions.find(b => normalize(b.text).includes(firstWord) && firstWord.length > 4);
          if (partialMatch) {
            await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, partialMatch.value, slog, DAC_STEPS.STEP3_SELECT_BARRIO, `K_Barrio (partial match: ${partialMatch.text})`);
          } else {
            // DO NOT pick first option blindly — a human would leave it empty rather than guess wrong
            slog.warn(DAC_STEPS.STEP3_SELECT_BARRIO,
              `Barrio "${detectedBarrioName}" detected but not in dropdown and no partial match — leaving at default (a human would not guess)`,
              { detected: detectedBarrioName, available: barrioOptions.map(b => b.text).slice(0, 10) }
            );
          }
        }
      } else {
        // No barrio detected — try city name as barrio (e.g. city="Aguada" IS a valid barrio)
        const cityAsBarrio = addr.city ? await findBarrioMatch(page, DAC_SELECTORS.RECIPIENT_BARRIO, addr.city) : null;
        if (cityAsBarrio) {
          await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, cityAsBarrio, slog, DAC_STEPS.STEP3_SELECT_BARRIO, `K_Barrio (city-as-barrio: ${addr.city})`);
          slog.info(DAC_STEPS.STEP3_SELECT_BARRIO, `Used city name "${addr.city}" as barrio match`);
        } else {
          // DO NOT select first option — it causes wrong barrio (e.g. "Aguada" for everything)
          slog.warn(DAC_STEPS.STEP3_SELECT_BARRIO,
            `No barrio detected (zip=${addr.zip ?? 'none'}, city=${addr.city ?? 'none'}) — leaving barrio at default`,
            { zip: addr.zip, city: addr.city, address1: addr.address1, intelligentSource: intelligent.source }
          );
        }
      }
    }
  } catch {
    slog.info(DAC_STEPS.STEP3_SELECT_BARRIO, 'Barrio field not available (optional)');
  }

  slog.info(DAC_STEPS.STEP3_OK, 'Step 3 recipient data complete', {
    name: fullName, phone, city: addr.city, province: addr.province,
    fullAddress, detectedBarrio: detectedBarrioName ?? 'none',
    intelligentSource: intelligent.source, intelligentConfidence: intelligent.confidence,
  });
  await dacBrowser.screenshot(page, `step3-complete-${order.name.replace('#', '')}`);

  // ===== BYPASS Step 3 Siguiente (BUG A: silent validation blocks advance) =====
  // CONFIRMED: The "Siguiente" button in Step 3 has a silent JS validation that
  // blocks advancement even with all fields filled. The workaround is to:
  // 1. Skip clicking Siguiente entirely
  // 2. Force fieldset#cargaEnvios visible (it has class d-none)
  // 3. Set lat/lng hidden fields (BUG B: DAC requires geocoded address)
  slog.info(DAC_STEPS.STEP3_SIGUIENTE, 'Skipping Step 3 Siguiente (silent validation bug) — forcing Step 4 visible');

  // 2026-05-11 INCIDENT — order #11865 (Curvadivina): the lat/lng bypass
  // below uses the DAC dropdown's selected-option text to look up department
  // coordinates. Previously it lowercased without normalizing diacritics, so
  // "Tacuarembó".toLowerCase() = "tacuarembó" (accent preserved) ≠ "tacuarembo"
  // (the coords-map key) → coords lookup returned undefined → fell back to the
  // MONTEVIDEO coordinates → DAC's backend used those coords as the
  // authoritative destination → guías for Tacuarembó / Paysandú / Río Negro /
  // San José all got created with destino MONTEVIDEO regardless of what we
  // selected in the K_Estado/K_Ciudad dropdowns.
  //
  // Symptom: order destined for Tacuarembó, customer's DAC tracking shows
  // "Destino: MONTEVIDEO". Package gets routed to the wrong DAC distribution
  // center and either bounces back or is held at an MVD branch.
  //
  // Affected departments (accent-bearing names):
  //   • Tacuarembó  → tacuarembó (✗ undefined) ⇒ MVD fallback
  //   • Paysandú    → paysandú    (✗ undefined) ⇒ MVD fallback
  //   • Río Negro   → río negro   (✗ undefined) ⇒ MVD fallback
  //   • San José    → san josé    (✗ undefined) ⇒ MVD fallback
  //
  // Fix: NFD-normalize + strip combining marks before lookup. This makes
  // "Tacuarembó" → "tacuarembo", "Río Negro" → "rio negro", etc. The coords
  // map keys stay accent-free as-is (they're internal); normalization happens
  // only on the dropdown text we read back.
  //
  // The pageHasLogger boolean ensures we surface a clear warning if a future
  // DAC dropdown introduces a new department name we don't know about, instead
  // of silently routing it to Montevideo.
  const coordResult = await page.evaluate(() => {
    // Force Step 4 visible
    const fieldset = document.getElementById('cargaEnvios');
    if (fieldset) {
      fieldset.classList.remove('d-none');
      fieldset.style.display = 'block';
    }
    // Set approximate lat/lng based on department for geocoding validation
    const lat = document.querySelector('[name="latitude"]') as HTMLInputElement;
    const lng = document.querySelector('[name="longitude"]') as HTMLInputElement;
    if (!lat || !lng) return { reason: 'no-lat-lng-fields', deptText: null, normalized: null, usedFallback: false };
    // Use department center coordinates (set by outer scope)
    const deptEl = document.querySelector('[name="K_Estado"]') as HTMLSelectElement;
    const deptTextRaw = deptEl?.options[deptEl.selectedIndex]?.text ?? '';
    // CRITICAL: normalize diacritics so "Tacuarembó" matches the "tacuarembo"
    // key. NFD splits the accent into a combining char which we then strip.
    const deptText = deptTextRaw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
      .trim();
    const coords: Record<string, [string, string]> = {
      'montevideo': ['-34.9011', '-56.1645'],
      'canelones': ['-34.5229', '-56.2817'],
      'maldonado': ['-34.9093', '-54.9588'],
      'colonia': ['-34.4625', '-57.8399'],
      'salto': ['-31.3883', '-57.9609'],
      'paysandu': ['-32.3213', '-58.0756'],
      'rivera': ['-30.9053', '-55.5508'],
      'tacuarembo': ['-31.7110', '-55.9834'],
      'rocha': ['-34.4833', '-54.2220'],
      'florida': ['-34.0994', '-56.2144'],
      'durazno': ['-33.3794', '-56.5227'],
      'lavalleja': ['-34.3519', '-55.2331'],
      'san jose': ['-34.3369', '-56.7133'],
      'soriano': ['-33.5098', '-57.7524'],
      'rio negro': ['-33.1195', '-58.3025'],
      'flores': ['-33.5239', '-56.8919'],
      'artigas': ['-30.4006', '-56.4674'],
      'cerro largo': ['-32.3739', '-54.1784'],
      'treinta y tres': ['-33.2305', '-54.3836'],
    };
    const exact = coords[deptText];
    const c = exact ?? coords['montevideo'];
    lat.value = c[0];
    lng.value = c[1];
    return {
      reason: exact ? 'exact-match' : 'fallback-mvd',
      deptText: deptTextRaw,
      normalized: deptText,
      usedFallback: !exact,
      coords: c,
    };
  });
  if (coordResult.usedFallback) {
    slog.warn(
      DAC_STEPS.STEP3_SIGUIENTE,
      `[lat-lng] Department "${coordResult.deptText}" (normalized="${coordResult.normalized}") not in coords map — falling back to Montevideo. THIS WILL MISCLASSIFY THE GUÍA. Add this department to the coords map.`,
      coordResult,
    );
  } else {
    slog.info(
      DAC_STEPS.STEP3_SIGUIENTE,
      `Forced cargaEnvios visible + set lat/lng for geocoding bypass (dept="${coordResult.deptText}" → coords=${coordResult.coords?.[0]},${coordResult.coords?.[1]})`,
      coordResult,
    );
  }

  // ===== STEP 4: Package type + Quantity + Submit =====
  slog.info(DAC_STEPS.STEP4_START, 'Filling Step 4: package type and quantity');

  // Set package type via Choices.js (native selectOption doesn't work)
  // Must click the Choices.js dropdown and select the option visually
  await page.evaluate(() => {
    // Set the hidden native select value
    const sel = document.querySelector('select[name="K_Tipo_Empaque"]') as HTMLSelectElement;
    if (sel) {
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  // Also click through Choices.js UI
  try {
    const choicesDiv = await page.$('.choices');
    if (choicesDiv) {
      await choicesDiv.click();
      await page.waitForTimeout(500);
      // Click the "Hasta 2Kg 20x20x20" option
      const option = page.locator('.choices__item--choice').filter({ hasText: '2Kg' }).first();
      if (await option.count() > 0) {
        await option.click();
        slog.info(DAC_STEPS.STEP4_FILL_PACKAGE, 'Selected Hasta 2Kg 20x20x20 via Choices.js click');
      } else {
        slog.info(DAC_STEPS.STEP4_FILL_PACKAGE, 'Set K_Tipo_Empaque=1 via hidden select (Choices.js option not found)');
      }
    }
  } catch {
    slog.info(DAC_STEPS.STEP4_FILL_PACKAGE, 'Set K_Tipo_Empaque=1 via hidden select fallback');
  }

  // Set quantity = 1
  await page.evaluate(() => {
    const el = document.querySelector('[name="Cantidad"]') as HTMLInputElement;
    if (el) { el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  slog.info(DAC_STEPS.STEP4_FILL_QTY, 'Set Cantidad = 1');

  await page.waitForTimeout(500);

  // ===== FILL OBSERVACIONES BEFORE Agregar (must be set before submission) =====
  // Build observations from: extraObs (apt/delivery notes) + order notes + note_attributes
  //
  // CRITICAL: Strip ALL internal markers, ISO timestamps, tracking metadata, and
  // long numeric IDs before sending to DAC. Multiple real leaks have been observed:
  //   1. "LabelFlow-GUIA: N" written by our own markOrderProcessed
  //   2. "labelflow-guia: N" lowercase from older code or plugins
  //   3. "Guía labelflow: N" reversed-order from polluted note_attributes
  //   4. "Guía: labelflow: N" with colon separator (v2 regex missed this)
  //   5. "Fecha: 2026-04-06T17:12:57.789Z" bare ISO timestamp attribute
  //   6. "882277908035" standalone tracking ID
  // The fix uses 4 independent signals (see filter helpers at top of file):
  //   - isLabelflowInternal: text contains "labelflow" OR ISO timestamp
  //   - shouldSkipNoteAttribute: name/value metadata + long ID patterns
  //   - sanitizeObservationLine: final belt-and-suspenders pass
  const observations: string[] = [];
  if (extraObs) observations.push(extraObs);
  // 2026-05-11 directive — inject the "call customer for missing door number"
  // note when an order shipped without a street number. Set upstream by the
  // missingStreetNumber handler when AI couldn't recover the number AND the
  // address isn't a pickup-at-DAC-branch.
  if (noNumberOperatorNote) observations.push(noNumberOperatorNote);
  // 2026-05-11 v2 — DAC observations field should ONLY contain operator-
  // actionable text (the customer's note + the no-number action note).
  // Earlier today this was injecting AI-correction audit trail too
  // ("AI corrigió: province X→Y" / "AI corrigió apellido: P → Pieri")
  // but the operator's feedback ("super mal") is that those messages
  // clutter the printed label without giving the operator any decision
  // to make — the AI already applied the fix, the label already has the
  // correct values. Operator just ships. So we leave those audit notes
  // in slog + RunLog (where they're queryable for SRE/debugging) but
  // do NOT push them to the DAC observations field anymore.
  //
  // The variables `addressAutoCorrectionNote` and `lastNameInferenceNote`
  // are intentionally retained — they could resurface in other places
  // (e.g. Shopify order note for operator-side visibility) without
  // touching the DAC printed label.
  void addressAutoCorrectionNote; // kept for audit logs, NOT pushed to DAC obs
  void lastNameInferenceNote;     // kept for audit logs, NOT pushed to DAC obs
  if (order.note) {
    const cleanNote = order.note
      .split('\n')
      .filter(line => !isLabelflowInternal(line) && !LONG_NUMERIC_ID_RE.test(line.trim()))
      .join('\n')
      .trim();
    if (cleanNote) observations.push(cleanNote);
  }
  if (order.note_attributes && Array.isArray(order.note_attributes)) {
    for (const attr of order.note_attributes) {
      if (!attr.value) continue;
      if (shouldSkipNoteAttribute(attr.name ?? '', String(attr.value))) continue;
      observations.push(`${attr.name}: ${attr.value}`);
    }
  }

  // Final belt-and-suspenders strip: sanitize each accumulated observation one
  // more time in case a marker slipped through the per-source filters above.
  const observationsClean = observations.map(sanitizeObservationLine).filter(Boolean);
  observations.length = 0;
  observations.push(...observationsClean);

  if (observations.length > 0) {
    const obsText = observations.join(' | ');
    slog.info(DAC_STEPS.STEP4_OK, `Will fill Observaciones: "${obsText.substring(0, 120)}"`, { fullText: obsText });

    // Use Playwright's native page.fill() — much more reliable than el.value assignment
    // Try multiple selectors in order of specificity
    const obsSelectors = [
      'textarea[name="Observaciones"]',
      'textarea[name="observaciones"]',
      'textarea[placeholder*="bservacion"]',
      '#cargaEnvios textarea',
      'fieldset textarea',
      'textarea',
    ];

    let obsFilled = false;
    for (const sel of obsSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;

        // Ensure the textarea is visible (force it if needed)
        await page.evaluate((s: string) => {
          const textarea = document.querySelector(s) as HTMLTextAreaElement;
          if (textarea) {
            textarea.style.display = 'block';
            textarea.style.visibility = 'visible';
            textarea.removeAttribute('hidden');
            textarea.removeAttribute('disabled');
            textarea.removeAttribute('readonly');
          }
        }, sel);
        await page.waitForTimeout(200);

        // Use Playwright fill (triggers proper input/change events)
        await page.fill(sel, obsText);

        // Verify the value was actually written
        const written = await page.$eval(sel, (el: any) => el.value).catch(() => '');
        if (written && written.length > 0) {
          obsFilled = true;
          slog.info(DAC_STEPS.STEP4_OK, `Observaciones filled via page.fill(): "${written.substring(0, 80)}"`, { selector: sel, length: written.length });
          break;
        } else {
          slog.warn(DAC_STEPS.STEP4_OK, `page.fill() on ${sel} did not persist — trying next selector`);
        }
      } catch {
        // Selector didn't work, try next
        continue;
      }
    }

    if (!obsFilled) {
      // Last resort: force fill ALL textareas via evaluate + manual events
      slog.warn(DAC_STEPS.STEP4_OK, 'All page.fill() attempts failed — using evaluate fallback');
      await page.evaluate((text: string) => {
        const textareas = Array.from(document.querySelectorAll('textarea'));
        for (const ta of textareas) {
          (ta as HTMLTextAreaElement).value = text;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          ta.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      }, obsText);
      // Verify
      const verifyObs = await page.evaluate(() => {
        const ta = document.querySelector('textarea') as HTMLTextAreaElement;
        return ta?.value ?? '';
      });
      if (verifyObs && verifyObs.length > 0) {
        slog.info(DAC_STEPS.STEP4_OK, `Observaciones filled via evaluate fallback: "${verifyObs.substring(0, 80)}"`);
      } else {
        slog.error(DAC_STEPS.STEP4_OK, `CRITICAL: Could not fill Observaciones field. Text was: "${obsText.substring(0, 80)}"`);
      }
    }
  } else {
    slog.info(DAC_STEPS.STEP4_OK, 'No observations to fill (extraObs empty, no order notes)');
  }

  // ===== CLICK "Agregar" (adds to cart) =====
  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Clicking Agregar button via JS evaluate');

  const agregarResult = await page.evaluate(() => {
    const fs = document.getElementById('cargaEnvios');
    if (fs) { fs.classList.remove('d-none'); fs.style.display = 'block'; }

    const btn = document.querySelector('.btnAdd') as HTMLButtonElement;
    if (btn) { btn.click(); return 'clicked .btnAdd'; }

    const buttons = Array.from(document.querySelectorAll('button'));
    for (const b of buttons) {
      if (b.textContent?.toLowerCase().includes('agregar')) { b.click(); return 'clicked Agregar by text'; }
    }
    return 'no button found';
  });

  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, `Agregar click result: ${agregarResult}`);
  if (agregarResult === 'no button found') {
    throw new Error('Agregar button not found in DOM');
  }

  // Wait for response
  await page.waitForTimeout(3000);

  // Handle address validation modal
  const modalDismissed = await page.evaluate(() => {
    const modal = document.querySelector('.modal.show, .swal2-container, [class*="modal"]');
    if (modal) {
      const closeBtn = modal.querySelector('button[data-dismiss="modal"], .close, button:last-child, .swal2-close') as HTMLButtonElement;
      if (closeBtn) { closeBtn.click(); return 'modal dismissed'; }
      const xBtn = modal.querySelector('.btn-close, [aria-label="Close"]') as HTMLButtonElement;
      if (xBtn) { xBtn.click(); return 'modal X clicked'; }
    }
    return 'no modal';
  });
  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, `Modal check: ${modalDismissed}`);

  // Check if item was added to cart
  await page.waitForTimeout(1000);
  const hasCartItem = await page.evaluate(() => {
    const body = document.body?.textContent ?? '';
    return body.includes('Finalizar') || body.includes('Total') || body.includes('Subtotal');
  });

  if (!hasCartItem) {
    slog.warn(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Cart item not detected, retrying Agregar click');
    // Re-fill observations before retry in case the form was reset
    if (observations.length > 0) {
      const retryObsText = observations.join(' | ');
      try {
        const obsSelRetry = [
          'textarea[name="Observaciones"]',
          'textarea[name="observaciones"]',
          'textarea[placeholder*="bservacion"]',
          'fieldset textarea',
          'textarea',
        ];
        for (const sel of obsSelRetry) {
          const el = await page.$(sel);
          if (!el) continue;
          await page.fill(sel, retryObsText).catch(() => {});
          break;
        }
        slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Re-filled observations before retry');
      } catch {
        // best-effort
      }
    }
    await page.evaluate(() => {
      const btn = document.querySelector('.btnAdd') as HTMLButtonElement;
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.modal.show .close, .modal.show button, .swal2-close') as HTMLButtonElement;
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(1000);
  }

  slog.info(DAC_STEPS.STEP4_OK, 'Item added to cart');

  // ===== CLICK "Finalizar envio" (BUG C: separate button after Agregar) =====
  // C-4 (2026-04-21 audit): write the PendingShipment marker BEFORE clicking
  // Finalizar. If the worker crashes between this insert and the guía
  // extraction below, reconcile.job.ts step 2 picks up the PENDING row and
  // the operator can manually match it against DAC historial. If a second
  // worker re-enters createShipment for the same order, the guard above
  // will see this row and throw DuplicateSubmitError before Finalizar can
  // fire twice.
  await markSubmitAttempted(tenantId, String(order.id), null);
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, 'Looking for Finalizar envio button');

  let finalizarResult: string;
  try {
    finalizarResult = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const b of buttons) {
        if (b.textContent?.toLowerCase().includes('finalizar')) {
          b.click();
          return 'clicked Finalizar envio';
        }
      }
      // Also try .btnSave class
      const saveBtn = document.querySelector('.btnSave') as HTMLButtonElement;
      if (saveBtn) { saveBtn.click(); return 'clicked .btnSave'; }
      return 'no Finalizar button found';
    });
  } catch (finErr) {
    // "Execution context was destroyed, most likely because of a navigation" means
    // the Finalizar click triggered a page redirect (DAC success flow). Treat as OK.
    if ((finErr as Error).message?.includes('Execution context was destroyed')) {
      finalizarResult = 'navigation-triggered (form submitted — context destroyed)';
      slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, 'Finalizar click caused immediate navigation — treating as success');
    } else {
      throw finErr;
    }
  }

  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `Finalizar result: ${finalizarResult}`);

  if (finalizarResult.includes('no Finalizar')) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, 'Finalizar button not found — item may only be in cart, not finalized');
  }

  // ===== AUTO PAYMENT (Plexo) for REMITENTE shipments when tenant has auto-pay on =====
  // DAC's Finalizar click triggers one of two flows depending on TipoGuia:
  //   - DESTINATARIO (4): DAC creates the guía directly and redirects to /envios/guiacreada
  //   - REMITENTE   (1): DAC initiates /envios/initiate_payWithFiserv and redirects to
  //                      secure.plexo.com.uy/{hash}. Payment must complete before the
  //                      guía page renders.
  // We invoke handlePaymentFlow ONLY when both paymentType = REMITENTE AND autoPay is
  // configured. On any non-success outcome, we continue to guía extraction anyway —
  // DAC may have created the guía with "pago pendiente" which the caller can then
  // mark as pending_manual in the Label record.
  let paymentOutcome: PaymentOutcome | null = null;
  if (paymentType === 'REMITENTE' && autoPay) {
    try {
      paymentOutcome = await handlePaymentFlow(page, autoPay, slog);
      slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] outcome: ${paymentOutcome.status}`, {
        reason: 'reason' in paymentOutcome ? paymentOutcome.reason : undefined,
      });
    } catch (payErr) {
      slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] handler threw — treating as pending_manual: ${(payErr as Error).message}`);
      paymentOutcome = { status: 'pending_manual', reason: 'unknown' };
    }
    // Short settle after Plexo; extractGuiaWithRetry will also wait internally.
    await page.waitForTimeout(2000);
  } else {
    // Original behavior for DESTINATARIO or when auto-pay is off
    await page.waitForTimeout(5000);
  }

  const currentUrl = page.url();
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `Current URL after Finalizar: ${currentUrl}`);

  await dacBrowser.screenshot(page, `after-finalizar-${order.name.replace('#', '')}`);

  // ===== EXTRACT GUIA (with built-in retry — NEVER re-submit the form) =====
  const guiaResult = await extractGuiaWithRetry(page, slog, order.name, usedGuias);

  // Safeguard: if we ended up with a PENDING- placeholder AND the URL never
  // moved away from /envios/nuevo, DAC almost certainly rejected the form
  // silently (bad address/department, validation error, etc.). Throwing here
  // prevents a stale PENDING- record from blocking future retries and surfaces
  // the order as FAILED in the Label so the user can investigate.
  //
  // Important for C-4: we delete the PendingShipment row on this path because
  // a form rejection means DAC did NOT create a shipment — no risk of a
  // duplicate on retry, and we want the next attempt to succeed without
  // hitting the duplicate-submit guard.
  // Mutable copies — the rescue path below may replace the PENDING- sentinel
  // with a real guía recovered from historial. We can't reassign guiaResult
  // (const) so we hoist locals here.
  let finalGuia = guiaResult.guia;
  let finalTrackingUrl = guiaResult.trackingUrl;

  if (finalGuia.startsWith('PENDING-') && currentUrl.includes('/envios/nuevo')) {
    // Best-effort: capture whatever DAC is actually displaying so the
    // Shopify note reflects the real rejection reason (bad ZIP, missing
    // barrio, invalid phone length, etc.) instead of our catch-all.
    //
    // 2026-04-22 — #11497 Jenny Pensotti rescue path. We now scrape the
    // DAC error box BEFORE deciding this is a real rejection. When the
    // URL is /envios/nuevo AND DAC is showing no validation error, the
    // URL signal is unreliable (DAC can redirect back to /envios/nuevo
    // after a successful submit). In that specific case we try a
    // recipient-matched historial rescue before giving up and poisoning
    // a real guía as "rejected".
    const dacErrorText = await scrapeDacErrorBox(page);

    if (!dacErrorText) {
      slog.warn(
        DAC_STEPS.SUBMIT_WAIT_NAV,
        `[rescue] URL is /envios/nuevo but DAC shows no validation error — attempting recipient-matched historial rescue for "${fullName}"`,
        { orderName: order.name, recipientName: fullName },
      );
      const rescued = await findRecentGuiaForRecipient(
        page,
        fullName,
        usedGuias ? Array.from(usedGuias) : [],
        slog,
        order.name,
        // 2026-05-11 incident #11865 — pass the destination we just typed/
        // selected so the rescue refuses to adopt a guía whose historial
        // destination row text doesn't contain the expected city/dept.
        // Prevents the "Tacuarembó order → MONTEVIDEO guía adopted" bug.
        { city: resolvedCity, department: resolvedDept },
      );
      if (rescued) {
        finalGuia = rescued.guia;
        finalTrackingUrl = rescued.trackingUrl;
      }
    }

    // If the rescue didn't find a matching guía, decide whether this is
    // (a) a GENUINE rejection — DAC showed a validation error, no guía
    //     exists, safe to retry after operator fixes Shopify; OR
    // (b) a SILENT-REJECT-AMBIGUOUS state — DAC's error box was empty
    //     AND the rescue couldn't find a matching guía. The guía MIGHT
    //     exist in DAC (rescue missed it for timing/pagination reasons)
    //     or DAC silently rejected. We can't tell from here.
    //
    // For (a): delete PendingShipment, throw, operator fixes address,
    // next cron retries cleanly.
    //
    // For (b): KEEP PendingShipment so the C-4 duplicate-submit guard
    // parks the order. Otherwise the next cron creates ANOTHER orphan
    // guía, and the next, and the next ("guía pile-up"). The operator
    // must manually verify DAC's historial and either link an existing
    // guía or unblock the order. Audit 2026-05-06.
    if (finalGuia.startsWith('PENDING-')) {
      const rescueFailed = !dacErrorText;

      if (!rescueFailed) {
        // Genuine rejection — safe to clear the C-4 guard.
        try {
          await db.pendingShipment.deleteMany({
            where: { tenantId, shopifyOrderId: String(order.id), status: 'PENDING' },
          });
        } catch (clearErr) {
          logger.warn(
            { error: (clearErr as Error).message, orderId: order.id },
            '[C-4] Failed to clear PendingShipment after rejected-form path',
          );
        }
        slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV,
          `[address-rejected] DAC error box: "${dacErrorText}"`,
          { orderName: order.name },
        );
      } else {
        // Silent reject + rescue exhausted — preserve PendingShipment so
        // the C-4 guard blocks the next cron tick from creating a
        // duplicate guía. Operator must verify and unblock.
        slog.warn(
          DAC_STEPS.SUBMIT_WAIT_NAV,
          `[rescue-failed] DAC error box empty AND historial rescue failed — KEEPING PendingShipment to prevent duplicate-guía creation. Operator must verify DAC historial for "${fullName}" and either link the guía or manually clear the PendingShipment row.`,
          {
            orderName: order.name,
            recipientName: fullName,
            shopifyCity: addr.city,
            shopifyAddress1: addr.address1,
            shopifyZip: addr.zip,
            audit: '2026-05-06',
          },
        );
      }

      // Audit 2026-05-06 — AI feasibility second-opinion on the silent
      // reject. The note we send Shopify changes meaningfully depending
      // on AI's verdict:
      //   - shippable=true (no concrete fix): probable DAC bug or transient
      //     issue; operator should check historial first, then maybe
      //     unblock for retry.
      //   - shippable=true (fix suggested): operator can apply the fix
      //     manually in Shopify and unblock.
      //   - shippable=false: address really IS broken; operator's
      //     specific question to ask the customer is in operatorQuestion.
      // The verdict is best-effort — if AI is unavailable we just fall
      // back to the original "verify historial" note.
      let dacFeasibilityNote = '';
      if (rescueFailed) {
        try {
          const verdict = await assessAddressFeasibility({
            reason: 'dac-silent-reject',
            tenantId,
            orderName: order.name,
            customerName: fullName,
            customerEmail: order.email ?? undefined,
            customerPhone: addr.phone ?? undefined,
            orderNotes: order.note ?? undefined,
            city: addr.city ?? undefined,
            address1: addr.address1,
            address2: addr.address2 ?? undefined,
            zip: addr.zip ?? undefined,
            province: addr.province ?? undefined,
            country: addr.country ?? undefined,
            attemptedDept: resolvedDept || undefined,
            attemptedCity: resolvedCity || undefined,
            attemptedBarrio: resolvedBarrioHint ?? undefined,
            // For dac-silent-reject, the dept we just tried is the
            // most accurate target for validating the AI's suggestedCity.
            targetDepartment: resolvedDept || undefined,
          });
          if (verdict.source === 'ai') {
            slog.info(
              DAC_STEPS.SUBMIT_WAIT_NAV,
              `[rescue-failed] AI feasibility verdict: shippable=${verdict.shippable}, confidence=${verdict.confidence}`,
              {
                orderName: order.name,
                aiShippable: verdict.shippable,
                aiConfidence: verdict.confidence,
                aiReasoning: verdict.reasoning,
                aiOperatorQuestion: verdict.operatorQuestion,
                aiSuggestedAddress1: verdict.suggestedAddress1,
                aiSuggestedCity: verdict.suggestedCity,
                aiCostUsd: verdict.aiCostUsd,
                audit: '2026-05-06',
              },
            );
            // Compose a concise feasibility line for the Shopify note.
            if (!verdict.shippable && verdict.operatorQuestion) {
              dacFeasibilityNote = `AI análisis: dirección incompleta. ${verdict.reasoning} Pregunta sugerida al cliente: "${verdict.operatorQuestion}"`;
            } else if (verdict.shippable && (verdict.suggestedAddress1 || verdict.suggestedCity)) {
              const fixes: string[] = [];
              if (verdict.suggestedAddress1) fixes.push(`dirección sugerida: "${verdict.suggestedAddress1}"`);
              if (verdict.suggestedCity) fixes.push(`ciudad sugerida: "${verdict.suggestedCity}"`);
              dacFeasibilityNote = `AI análisis: dirección probablemente válida con fix. ${fixes.join(', ')}. ${verdict.reasoning}`;
            } else if (verdict.shippable) {
              dacFeasibilityNote = `AI análisis: dirección parece válida — probable bug de DAC. ${verdict.reasoning}`;
            }
          }
        } catch (verdictErr) {
          // Never fail the throw because of an AI-call hiccup.
          logger.warn(
            { error: (verdictErr as Error).message, orderName: order.name },
            '[rescue-failed] AI feasibility call threw; falling back to default note',
          );
        }
      }

      // Observability: log whether the AI fallback was actually consulted
      // before we gave up. A common failure mode is `ANTHROPIC_API_KEY`
      // being unset in Render → the AI call returns null silently, the
      // deterministic resolver can't classify "Mvdo.", and we end up here.
      // This line makes that path visible in the logs.
      slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV,
        `[address-rejected] AI resolver status before throw: ${
          aiResolution
            ? `ran (source=${aiResolution.source}, confidence=${aiResolution.confidence}, dept=${aiResolution.department})`
            : 'NOT invoked or returned null — deterministic path only'
        }`,
        {
          orderName: order.name,
          aiInvoked: aiResolution != null,
          city: addr.city,
          zip: addr.zip,
          rescueFailed,
        },
      );
      // The dacErrorText surfaces in the Shopify operator note via
      // process-orders.job.ts. For silent-rejects we pass the AI
      // feasibility verdict (when available) so the note tells the
      // operator EXACTLY what to do next instead of a generic
      // "verify historial".
      const errorTextForNote = rescueFailed
        ? (dacFeasibilityNote || '')
        : dacErrorText;
      throw new DacAddressRejectedError(
        rescueFailed
          ? `DAC silently rejected the form for ${order.name} (URL on /envios/nuevo, error box empty, rescue exhausted). ` +
            `An orphan guía MAY exist in DAC for "${fullName}" — operator must verify historial manually.` +
            (dacFeasibilityNote ? ` AI verdict: ${dacFeasibilityNote}` : '')
          : `DAC rejected the shipment form for ${order.name} (URL stayed on /envios/nuevo and no guía was extracted). ` +
            `Likely cause: address could not be classified into a valid department/barrio. Review the customer address in Shopify.` +
            (dacErrorText ? ` DAC validation text: "${dacErrorText}"` : ''),
        order.name,
        errorTextForNote,
        rescueFailed,
      );
    }
  }

  // C-4: DAC accepted the form and we have a real guía. Mark the
  // PendingShipment row resolved so reconcile won't orphan it.
  if (!finalGuia.startsWith('PENDING-')) {
    await markSubmitResolved(tenantId, String(order.id), finalGuia);
  }

  // Resolve the payment status to persist on the Label:
  //   - DESTINATARIO                     → 'not_required'
  //   - REMITENTE + auto-pay off         → 'not_required' (tenant will pay manually)
  //   - REMITENTE + auto-pay + outcome   → mirror the Plexo outcome
  let paymentStatus: DacShipmentResult['paymentStatus'];
  let paymentFailureReason: string | undefined;
  if (paymentType === 'DESTINATARIO') {
    paymentStatus = 'not_required';
  } else if (!autoPay) {
    paymentStatus = 'not_required';
  } else if (paymentOutcome) {
    paymentStatus = paymentOutcome.status;
    paymentFailureReason = 'reason' in paymentOutcome ? paymentOutcome.reason : undefined;
  } else {
    paymentStatus = 'pending_manual';
    paymentFailureReason = 'unknown';
  }

  return {
    guia: finalGuia,
    trackingUrl: finalTrackingUrl,
    screenshotPath: '',
    // Pass the AI resolution hash back to the job runner for feedback recording
    aiResolutionHash: aiResolution?.inputHash,
    paymentStatus,
    paymentFailureReason,
  };
}

/**
 * Extract guia numbers AND their href links from <a> elements on the page.
 * Returns array of { guia, href } objects.
 */
/**
 * Extract guias + their tracking URLs from the current DAC page.
 *
 * RESILIENCE: this is called immediately after clicking "Finalizar" on the DAC
 * form, while DAC is still navigating to the confirmation page. If the page
 * context is destroyed mid-evaluate (classic Playwright "Execution context was
 * destroyed, most likely because of a navigation" error), we DO NOT throw — we
 * wait for the page to stabilize and retry up to 3 times. On the final retry,
 * we return an empty array instead of throwing, so the caller can fall through
 * to Method 2 (historial lookup) rather than aborting the whole order.
 *
 * The stakes are high here: if this function throws, the order is marked failed
 * but DAC has ALREADY created and charged the guia. That leaves an orphan guia
 * in the DAC system with no corresponding Label row in our DB — a real money
 * leak (#1146, #1143, #1138 on 2026-04-10).
 */
async function extractGuiasWithLinks(pg: Page): Promise<{ guia: string; href: string | null }[]> {
  const GUIA_REGEX = /\b88\d{10,}\b/;
  const EVAL_MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= EVAL_MAX_ATTEMPTS; attempt++) {
    try {
      // Wait for the page to be at least minimally loaded before evaluating.
      // This avoids the race where the context is destroyed mid-eval.
      try {
        await pg.waitForLoadState('domcontentloaded', { timeout: 5_000 });
      } catch {
        // Ignore — the page might already be loaded (waitForLoadState only waits
        // if there's an active navigation). Continue to evaluate.
      }

      return await pg.evaluate((regexStr: string) => {
        const regex = new RegExp(regexStr);
        const results: { guia: string; href: string | null }[] = [];
        const seen = new Set<string>();

        // First: extract from <a> elements (these have the real tracking URLs)
        const links = Array.from(document.querySelectorAll('a'));
        for (const a of links) {
          const text = a.textContent?.trim() ?? '';
          if (regex.test(text)) {
            const g = text.match(new RegExp(regexStr))?.[0];
            if (g && !seen.has(g)) {
              seen.add(g);
              results.push({ guia: g, href: a.href || null });
            }
          }
        }

        // Second: extract from full page text (catches guias not in links)
        const allMatches = (document.body?.textContent ?? '').match(new RegExp(regexStr, 'g')) ?? [];
        for (const g of allMatches) {
          if (!seen.has(g)) {
            seen.add(g);
            results.push({ guia: g, href: null });
          }
        }

        return results;
      }, GUIA_REGEX.source);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const isNavigationRace = msg.includes('Execution context was destroyed')
        || msg.includes('Target page, context or browser has been closed')
        || msg.includes('Target closed');
      if (!isNavigationRace) {
        // Unexpected error — propagate
        throw err;
      }
      if (attempt === EVAL_MAX_ATTEMPTS) {
        // Final attempt failed — return empty instead of throwing so the caller
        // can fall through to Method 2 (historial lookup).
        return [];
      }
      // Navigation in progress — wait a bit longer and retry
      await pg.waitForTimeout(1500);
    }
  }
  return [];
}

/**
 * Pick the HIGHEST numbered guia from results (highest = most recently created).
 * This is more reliable than picking "last in DOM" which depends on page ordering.
 */
function pickHighestGuia(results: { guia: string; href: string | null }[]): { guia: string; href: string | null } {
  return results.reduce((best, curr) => {
    if (!best) return curr;
    return BigInt(curr.guia) > BigInt(best.guia) ? curr : best;
  }, results[0]);
}

/**
 * Lowercase, strip accents, collapse whitespace. Used to fuzzy-match
 * recipient names between Shopify (what we filled on the DAC form) and
 * DAC's historial rows (what DAC stored on its side). DAC sometimes
 * normalises names (upper-cases, strips accents) so we compare in a
 * normalised form on both sides.
 */
function normalizeNameForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure helper — given a set of historial rows (guía + visible row text)
 * and a recipient name, return the best candidate guía that belongs to
 * this recipient, or null if no row can be positively attributed.
 *
 * Why we need this:
 * The post-Finalizar URL is not always a reliable rejection signal.
 * DAC can create a guía AND then redirect the browser back to
 * /envios/nuevo (e.g. when the tenant has the "start a new shipment"
 * flow active). The original guard (shipment.ts:2437-2459) treats every
 * /envios/nuevo URL as "DAC rejected", disables historial lookup, and
 * the real guía gets orphaned — no row in our DB, but DAC bills the
 * tenant anyway. This is the #11497 Jenny Pensotti failure mode
 * (2026-04-22 20:55): DAC minted guía 8821127182837, our worker threw
 * DacAddressRejectedError, Shopify got the "dirección confusa" note,
 * customer never received tracking.
 *
 * Why it's safe:
 * We never pick a historial row blindly. We require every token of
 * the recipient name (normalised, >=3 chars) to appear in the row's
 * text. Generic single-letter or short tokens are discarded so an
 * operator's "Ana" doesn't match every shipment to "Analía".
 * Guías already in our DB (excludeGuias) are always filtered out.
 *
 * Returns null when:
 *   - the recipient name is too short/empty to be distinctive
 *   - no row in historial contains all the name tokens
 *   - every matching row's guía is already in our DB
 *
 * Exported for unit testing — the I/O wrapper below calls this.
 */
export function pickMatchingHistorialRow(
  rows: { guia: string; href: string | null; text: string }[],
  recipientName: string,
  excludeGuias: string[],
  // 2026-05-11 incident — order #11865 Curvadivina. DAC silently created a
  // guía with destination MONTEVIDEO even though our form said Tacuarembó
  // (root cause: lat/lng coords map missed accent-bearing dept names; see
  // shipment.ts:~2193). The rescue path then adopted that bogus guía because
  // the recipient name matched — name was the only check. Customer's tracking
  // page showed "Destino: MONTEVIDEO" for a Tacuarembó order.
  //
  // Defence-in-depth: when the caller knows the expected destination, ALSO
  // require the row text to mention the expected city OR department. If a row
  // matches by name but the destination is wrong, we treat it as a
  // misclassified DAC-side guía and refuse to adopt it. The order falls
  // through to "silent reject + rescue exhausted" and the operator must
  // verify manually (PendingShipment keeps the order parked, no duplicate).
  //
  // Pass `null`/undefined for expectedDestination to keep the legacy
  // name-only behaviour (used by older tests).
  expectedDestination?: { city?: string | null; department?: string | null } | null,
): { guia: string; href: string | null; text: string } | null {
  if (!recipientName || recipientName.trim().length < 3) return null;

  const normName = normalizeNameForMatch(recipientName);
  const nameTokens = normName.split(' ').filter((t) => t.length >= 3);
  // Require at least TWO distinctive tokens (>=3 chars each). A single
  // short token like "Ana" would substring-match inside "ANALIA" and
  // cause false positives. Requiring first+last name (or equivalent)
  // keeps the rescue path safely narrow.
  if (nameTokens.length < 2) return null;

  const exclude = new Set(excludeGuias);

  // Build the destination-token set we'll require. We accept a match if the
  // row text contains EITHER the expected city OR the expected department
  // (both normalised). DAC historial rows display "CITY · DEPT" or just one
  // of them depending on the row, so requiring either is the most forgiving
  // correct check.
  const destTokens: string[] = [];
  if (expectedDestination) {
    for (const v of [expectedDestination.city, expectedDestination.department]) {
      if (!v) continue;
      const norm = normalizeNameForMatch(v);
      if (norm.length >= 4) destTokens.push(norm);
    }
  }
  const requireDestination = destTokens.length > 0;

  const candidates = rows.filter((r) => {
    if (exclude.has(r.guia)) return false;
    // Split row text into tokens the same way as the name, then check
    // every name token appears as an EXACT token in the row. This
    // avoids the "ana" → "analia" substring false positive that a
    // naive String.includes would cause.
    const rowNormalised = normalizeNameForMatch(r.text);
    const rowTokens = new Set(rowNormalised.split(' '));
    const nameMatches = nameTokens.every((tok) => rowTokens.has(tok));
    if (!nameMatches) return false;
    if (!requireDestination) return true;
    // Destination check uses INCLUDES (substring) on the joined normalised
    // text — destinations can be multi-word ("rio negro", "treinta y tres",
    // "punta del este") and may appear as a phrase rather than as discrete
    // tokens. Any of the expected dest strings is sufficient.
    return destTokens.some((d) => rowNormalised.includes(d));
  });

  if (candidates.length === 0) return null;

  // Multiple matches for the same recipient name is unusual but possible
  // (e.g. a repeat customer whose older shipments are still on page 1 of
  // historial). Pick the HIGHEST-numbered guía — DAC guía numbers are
  // monotonic, so highest == newest == the one we just created.
  return candidates.reduce<typeof candidates[number] | null>((best, curr) => {
    if (!best) return curr;
    return BigInt(curr.guia) > BigInt(best.guia) ? curr : best;
  }, null);
}

/**
 * Scan the currently-rendered DAC historial page and return every row
 * containing a guía number. Pure DOM read — no navigation, no waiting.
 * Used by findRecentGuiaForRecipient on each retry / pagination step.
 */
async function scrapeHistorialRows(
  page: Page,
): Promise<{ guia: string; href: string | null; text: string }[]> {
  const GUIA_REGEX_SRC = '\\b88\\d{10,}\\b';
  return page.evaluate((regexStr: string) => {
    const regex = new RegExp(regexStr);
    const out: { guia: string; href: string | null; text: string }[] = [];
    // DAC's historial page renders each shipment as a <tr>; we scan
    // every row for a guía-shaped number, the row's visible text
    // (for name matching), and any anchor href (tracking URL).
    const trs = Array.from(document.querySelectorAll('tr'));
    for (const tr of trs) {
      const text = (tr as HTMLElement).innerText?.trim() ?? '';
      const m = text.match(regex);
      if (!m) continue;
      const link = tr.querySelector('a') as HTMLAnchorElement | null;
      out.push({ guia: m[0], href: link?.href ?? null, text });
    }
    return out;
  }, GUIA_REGEX_SRC);
}

/**
 * Best-effort: try to load more historial rows by clicking pagination /
 * "load more" controls. DAC's historial uses server-side pagination with
 * "Siguiente" / page-number links and (sometimes) infinite scroll.
 *
 * Returns true if more rows were likely loaded (so the caller should
 * re-scrape), false if no obvious pagination control was found.
 *
 * Defensive: any error returns false rather than throwing — pagination
 * is an optimization, not a hard requirement. The caller decides whether
 * to retry without it.
 */
async function loadMoreHistorialRows(page: Page): Promise<boolean> {
  try {
    const advanced = await page.evaluate(() => {
      // 1. "Siguiente" / "Next" link in pagination
      const links = Array.from(document.querySelectorAll('a, button')) as HTMLElement[];
      for (const el of links) {
        const txt = (el.innerText ?? '').trim().toLowerCase();
        if (txt === 'siguiente' || txt === 'next' || txt === '›' || txt === 'next ›') {
          const ariaDisabled = el.getAttribute('aria-disabled');
          const cls = el.className ?? '';
          if (ariaDisabled !== 'true' && !/\bdisabled\b/.test(cls)) {
            (el as HTMLAnchorElement | HTMLButtonElement).click();
            return true;
          }
        }
      }
      // 2. "Cargar más" / "Mostrar más" infinite-scroll buttons
      for (const el of links) {
        const txt = (el.innerText ?? '').trim().toLowerCase();
        if (txt.startsWith('cargar más') || txt.startsWith('mostrar más') || txt.startsWith('load more')) {
          (el as HTMLElement).click();
          return true;
        }
      }
      // 3. Scroll to bottom in case DAC uses scroll-triggered lazy-load
      window.scrollTo(0, document.body.scrollHeight);
      return false;
    });
    if (advanced) {
      // Give DAC a moment to fetch & render the next page
      await page.waitForTimeout(2_000);
    }
    return advanced;
  } catch {
    return false;
  }
}

/**
 * Rescue path for the "URL stuck on /envios/nuevo but DAC actually created
 * the guía" failure mode. Navigates to DAC historial and looks for a row
 * whose visible text matches the recipient name we filled on the form.
 *
 * Audit 2026-05-06 — robustness rewrite. The previous single-shot lookup
 * was failing intermittently in production: DAC's historial occasionally
 * showed only 1–5 rows on first load (race between our navigation and
 * DAC's server-side render), so the just-created guía wasn't visible
 * even when it existed. Result: orphan guías DAC charged us for, no
 * tracking link, and the order got reprocessed on the next cron tick →
 * second orphan guía, third, etc. ("guía pile-up").
 *
 * The new path:
 *   1. Navigate with `networkidle` (waits for fetch/XHR to settle, not
 *      just initial HTML)
 *   2. Wait an additional 6 s for DAC's server-rendered shipments table
 *      to finish populating
 *   3. Retry the scrape up to 3 times (5 s, 10 s, 15 s backoff) — if
 *      historial was still incomplete on attempt 1, attempt 2 usually
 *      catches it
 *   4. On each attempt, scan multiple historial pages by clicking
 *      "Siguiente" / "Cargar más" (best-effort, errors are non-fatal)
 *
 * This is intentionally narrower than the old blind historial lookup:
 * we require a positive recipient-name match, so orphan guías from
 * unrelated submissions (the #11481 Noelia Osorio poisoning bug) cannot
 * be adopted.
 *
 * Returns null on any failure (navigation error, empty page, no matching
 * row). Never throws — the caller falls back to throwing
 * DacAddressRejectedError with `rescueFailed=true`.
 */
async function findRecentGuiaForRecipient(
  page: Page,
  recipientName: string,
  excludeGuias: string[],
  slog: StepLogger,
  orderName: string,
  // 2026-05-11 — passed through to pickMatchingHistorialRow so the rescue
  // refuses to adopt a guía whose historial-row destination doesn't match
  // the order's resolved city/department. Caller passes the city + dept it
  // just typed/selected on the DAC form. Pass null to disable the check
  // (legacy callers / tests).
  expectedDestination: { city?: string | null; department?: string | null } | null = null,
): Promise<{ guia: string; trackingUrl?: string } | null> {
  if (!recipientName || recipientName.trim().length < 3) {
    slog.warn(
      DAC_STEPS.SUBMIT_EXTRACT_GUIA,
      '[rescue] recipientName too short — skipping historial rescue to avoid false positives',
      { recipientName, orderName },
    );
    return null;
  }

  // Cap at 3 attempts, with backoff between attempts. Each attempt does a
  // fresh navigation + multi-page scrape.
  const ATTEMPT_BACKOFF_MS = [0, 5_000, 10_000];
  const MAX_PAGINATION_PAGES = 3;
  let lastRowCount = 0;
  // Tracks whether name-only matches existed but were filtered out by the
  // destination check. We surface this so the operator can investigate
  // (DAC almost certainly minted a misclassified guía — see #11865 incident).
  let sawNameOnlyMatchWithWrongDest = false;

  for (let attempt = 1; attempt <= ATTEMPT_BACKOFF_MS.length; attempt++) {
    if (ATTEMPT_BACKOFF_MS[attempt - 1] > 0) {
      slog.info(
        DAC_STEPS.SUBMIT_EXTRACT_GUIA,
        `[rescue] Attempt ${attempt}/${ATTEMPT_BACKOFF_MS.length} — backing off ${ATTEMPT_BACKOFF_MS[attempt - 1]}ms before retry`,
        { orderName, recipientName },
      );
      await page.waitForTimeout(ATTEMPT_BACKOFF_MS[attempt - 1]);
    }

    try {
      // networkidle waits for fetch/XHR (used by DAC's historial table).
      // 30 s budget — DAC's historial is sometimes slow under load.
      await page.goto(DAC_URLS.HISTORY, { waitUntil: 'networkidle', timeout: 30_000 });
      // Extra grace period on top of networkidle for any server-rendered
      // delayed content (DAC's historial table has been observed empty
      // for ~5 s after networkidle fires).
      await page.waitForTimeout(6_000);
    } catch (navErr) {
      slog.warn(
        DAC_STEPS.SUBMIT_EXTRACT_GUIA,
        `[rescue] Attempt ${attempt} — could not navigate to historial: ${(navErr as Error).message}`,
        { orderName, attempt },
      );
      continue; // try the next attempt
    }

    // Scrape page 1, then walk pagination up to MAX_PAGINATION_PAGES.
    let allRows: { guia: string; href: string | null; text: string }[] = [];
    try {
      allRows = await scrapeHistorialRows(page);
    } catch (evalErr) {
      slog.warn(
        DAC_STEPS.SUBMIT_EXTRACT_GUIA,
        `[rescue] Attempt ${attempt} — page-1 scrape failed: ${(evalErr as Error).message}`,
        { orderName, attempt },
      );
      continue;
    }

    let firstMatch = pickMatchingHistorialRow(allRows, recipientName, excludeGuias, expectedDestination);
    let pageNum = 1;
    while (!firstMatch && pageNum < MAX_PAGINATION_PAGES) {
      const advanced = await loadMoreHistorialRows(page);
      if (!advanced) break;
      pageNum++;
      try {
        const moreRows = await scrapeHistorialRows(page);
        // Merge — dedup by guía
        const seen = new Set(allRows.map((r) => r.guia));
        for (const r of moreRows) {
          if (!seen.has(r.guia)) {
            allRows.push(r);
            seen.add(r.guia);
          }
        }
        firstMatch = pickMatchingHistorialRow(allRows, recipientName, excludeGuias, expectedDestination);
      } catch (pageErr) {
        slog.warn(
          DAC_STEPS.SUBMIT_EXTRACT_GUIA,
          `[rescue] Attempt ${attempt} — page-${pageNum} scrape failed: ${(pageErr as Error).message}`,
          { orderName, attempt, pageNum },
        );
        break;
      }
    }

    lastRowCount = allRows.length;

    if (firstMatch) {
      slog.success(
        DAC_STEPS.SUBMIT_OK,
        `[rescue] Recovered guía ${firstMatch.guia} from historial via recipient + destination match — would have been orphaned`,
        {
          orderName,
          recipientName,
          guia: firstMatch.guia,
          attempt,
          rowsScanned: allRows.length,
          pagesScanned: pageNum,
          expectedCity: expectedDestination?.city ?? null,
          expectedDepartment: expectedDestination?.department ?? null,
        },
      );
      return { guia: firstMatch.guia, trackingUrl: firstMatch.href ?? undefined };
    }

    // Did we have any name-matching rows that the destination filter
    // rejected? If yes, that's an EXTREMELY informative signal — DAC almost
    // certainly created a guía with the wrong destination. We surface that
    // separately so the operator (and our metrics) can tell it apart from
    // a clean "no guía was ever created" case.
    //
    // (At this point firstMatch is null — the early `if (firstMatch)` block
    // above returned. So a `nameOnly` hit means the row was filtered out by
    // the destination check specifically.)
    if (expectedDestination) {
      const nameOnly = pickMatchingHistorialRow(allRows, recipientName, excludeGuias, null);
      if (nameOnly) {
        sawNameOnlyMatchWithWrongDest = true;
        slog.warn(
          DAC_STEPS.SUBMIT_EXTRACT_GUIA,
          `[rescue] Found name-match guía ${nameOnly.guia} but its destination does NOT contain expected city/dept — REFUSING to adopt to prevent misclassified-guía bug (incident #11865)`,
          {
            orderName,
            recipientName,
            candidateGuia: nameOnly.guia,
            candidateRowText: nameOnly.text,
            expectedCity: expectedDestination.city,
            expectedDepartment: expectedDestination.department,
          },
        );
      }
    }

    slog.info(
      DAC_STEPS.SUBMIT_EXTRACT_GUIA,
      `[rescue] Attempt ${attempt}: no match in ${allRows.length} rows across ${pageNum} page(s)`,
      { orderName, recipientName, attempt, rowsScanned: allRows.length, pagesScanned: pageNum },
    );
  }

  slog.warn(
    DAC_STEPS.SUBMIT_EXTRACT_GUIA,
    `[rescue] All ${ATTEMPT_BACKOFF_MS.length} attempts exhausted — no historial row matched recipient "${recipientName}"${sawNameOnlyMatchWithWrongDest ? ' WITH the expected destination (a name-match with wrong dest existed — likely DAC-side misclassification)' : ''} (last scan: ${lastRowCount} rows)`,
    { orderName, recipientName, totalAttempts: ATTEMPT_BACKOFF_MS.length, lastRowCount, sawNameOnlyMatchWithWrongDest },
  );
  return null;
}

/**
 * Extracts guia with retry logic. ONLY retries the guia extraction navigation,
 * NEVER re-submits the DAC form (the shipment is already created at this point).
 *
 * ── GUIA POISONING GUARD (2026-04-22 post-run audit) ───────────────────────
 * When DAC rejects the shipment form silently, the browser URL stays on
 * /envios/nuevo — NO shipment was created on DAC's side. Historial lookup
 * (Method 2 below) is DANGEROUS in that state because it will happily pick
 * up ANY "new" (not-in-our-DB) guía in the tenant's DAC historial, including:
 *   • shipments the tenant created manually in the DAC web UI
 *   • shipments from a previous DAC account / pre-LabelFlow era
 *   • shipments created by a different integration (if any)
 * and attribute that orphan guía to the current order. The customer then gets
 * a tracking email for a COMPLETELY UNRELATED package, and the actual order
 * was never shipped at all.
 *
 * Real-world impact (confirmed 2026-04-22): order #11481 (Noelia Osorio,
 * Parquizado/San José) failed DAC validation ("Parquizado" wasn't in the
 * Lavalleja city list because Parquizado actually belongs to San José). URL
 * stayed on /envios/nuevo. Historial lookup picked the tenant's orphan guía
 * 8821122926412 (from an older batch range 8821122xxx, while the current
 * batch was on 8821124xxx), saved it to the DB, and fulfilled Shopify with
 * the wrong tracking. DAC screenshot confirmed Noelia's shipment was never
 * created.
 *
 * Fix: if the post-Finalizar URL is /envios/nuevo, SKIP Method 2 entirely.
 * Method 1 (current-page scan) still runs — in rare cases DAC renders the
 * confirmation inline without changing the URL, and that page's content is
 * trustworthy because it was produced by THIS submission.
 */
async function extractGuiaWithRetry(
  page: Page,
  slog: StepLogger,
  orderName: string,
  usedGuias?: Set<string>,
  maxAttempts: number = 3,
): Promise<{ guia: string; trackingUrl?: string }> {
  const excludeGuias = usedGuias ? Array.from(usedGuias) : [];
  let guia = '';
  let trackingUrl: string | undefined;

  // Capture the URL at entry — this is the post-Finalizar URL the caller
  // logged. We snapshot it so later navigations (e.g. go to historial) don't
  // confuse the poisoning guard.
  const entryUrl = page.url();
  const submissionWasRejected = /\/envios\/nuevo(\/?|$|\?)/.test(entryUrl);
  if (submissionWasRejected) {
    slog.warn(
      DAC_STEPS.SUBMIT_EXTRACT_GUIA,
      'Post-Finalizar URL is /envios/nuevo — DAC rejected the form. Historial lookup disabled to prevent guía poisoning.',
      { entryUrl, orderName },
    );
  }

  slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Extracting guia number');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Guia extraction retry ${attempt}/${maxAttempts} (NOT re-submitting form)`);
      await page.waitForTimeout(2000);
    }

    const currentUrl = page.url();

    // Method 0: Extract guia from confirmation page URL (/envios/guiacreada/XXXXX)
    // Wrap page.evaluate in try/catch — if navigation is still in progress, this
    // would throw "Execution context was destroyed" and abort the whole order.
    // We don't strictly need this preview; it's only for logging/debugging. If it
    // fails, log a warning and continue to Method 1.
    if (currentUrl.includes('guiacreada')) {
      await page.waitForTimeout(2000);
      try {
        const pagePreview = await page.evaluate(() => document.body?.textContent?.substring(0, 500) ?? '');
        slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Confirmation page content preview: "${pagePreview.substring(0, 200)}"`);
      } catch (previewErr) {
        const msg = (previewErr as Error).message ?? '';
        if (msg.includes('Execution context was destroyed') || msg.includes('Target closed')) {
          slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Confirmation page still navigating — skipping preview, continuing to extraction');
          await page.waitForTimeout(1500);
        } else {
          throw previewErr;
        }
      }
    }

    // Method 1: Search CURRENT page for guia + href, excluding already-assigned ones
    let pageResults = await extractGuiasWithLinks(page);
    let newResults = pageResults.filter(r => !excludeGuias.includes(r.guia));

    if (pageResults.length > 0) {
      slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Current page: ${pageResults.length} guias found, ${pageResults.length - newResults.length} excluded (already in DB)`, {
        found: pageResults.map(r => r.guia),
        excluded: pageResults.filter(r => excludeGuias.includes(r.guia)).map(r => r.guia),
        new: newResults.map(r => r.guia),
      });
    }

    if (newResults.length > 0) {
      const picked = pickHighestGuia(newResults);
      guia = picked.guia;
      trackingUrl = picked.href || undefined;
      slog.success(DAC_STEPS.SUBMIT_OK, `Guia found on current page: ${guia}`, {
        guia, trackingUrl: trackingUrl ?? 'none', orderName, url: currentUrl,
        totalOnPage: pageResults.length, excluded: excludeGuias.length,
      });
      break;
    }

    // GUIA POISONING GUARD (2026-04-22 post-run audit): if DAC rejected the
    // form (URL stayed on /envios/nuevo), historial lookup is unsafe. Skip it
    // and let the caller surface this as a rejected-form error. See the
    // function-level comment for the full rationale.
    if (submissionWasRejected) {
      slog.info(
        DAC_STEPS.SUBMIT_EXTRACT_GUIA,
        `Attempt ${attempt}/${maxAttempts}: Skipping historial lookup — DAC rejected the form (poisoning guard)`,
        { orderName },
      );
      continue;
    }

    // Method 2: Navigate to historial and find the NEW guia
    try {
      slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Guia not on current page — checking mis envios');
      await page.goto('https://www.dac.com.uy/envios', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForTimeout(3000);

      pageResults = await extractGuiasWithLinks(page);
      newResults = pageResults.filter(r => !excludeGuias.includes(r.guia));

      if (newResults.length > 0) {
        const picked = pickHighestGuia(newResults);
        guia = picked.guia;
        trackingUrl = picked.href || undefined;
        slog.success(DAC_STEPS.SUBMIT_OK, `Guia found in historial: ${guia}`, {
          guia, trackingUrl: trackingUrl ?? 'none', orderName,
          totalOnPage: pageResults.length, excluded: excludeGuias.length,
          newGuiasAvailable: newResults.length,
        });
        break;
      } else if (pageResults.length > 0) {
        slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Attempt ${attempt}: All ${pageResults.length} guias on historial already assigned`, {
          orderName,
        });
      }
    } catch (navErr) {
      slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Attempt ${attempt}: Navigation to historial failed: ${(navErr as Error).message}`);
    }
  }

  // Method 3: If we have guia but no trackingUrl, try to find the link in historial
  if (guia && !trackingUrl && !guia.startsWith('PENDING-')) {
    slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Have guia ${guia} but no tracking URL, checking historial for link`);
    try {
      if (!page.url().includes('/envios')) {
        await page.goto('https://www.dac.com.uy/envios', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(3000);
      }
      const linkHref = await page.evaluate((g: string) => {
        const links = Array.from(document.querySelectorAll('a'));
        for (const a of links) {
          if (a.textContent?.trim().includes(g)) return a.href || null;
        }
        return null;
      }, guia);
      if (linkHref) {
        trackingUrl = linkHref;
        slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Found tracking URL for guia in historial`, { guia, trackingUrl });
      }
    } catch {
      slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Could not navigate to historial for tracking URL');
    }
  }

  // Last resort: PENDING
  if (!guia) {
    guia = `PENDING-${Date.now()}`;
    slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Could not extract guia after ${maxAttempts} attempts`, { orderName, url: page.url() });
    await dacBrowser.screenshot(page, `no-guia-found-${orderName.replace('#', '')}`);
  }

  return { guia, trackingUrl };
}
