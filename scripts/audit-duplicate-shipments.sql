-- ─────────────────────────────────────────────────────────────────────────────
-- audit-duplicate-shipments.sql  —  2026-04-22 double-shipping incident
-- ─────────────────────────────────────────────────────────────────────────────
--
-- CONTEXT
-- -------
-- Between commit 4fa04c4 (deployed 2026-04-22 ~11:00 UTC) and hotfix e03b024
-- (deployed a few hours later), every cron tick where Shopify fulfillment
-- silently failed re-picked the same order and minted a NEW DAC guía. The
-- failure cycle per order was:
--
--   1) worker submits order to DAC, gets guía G1
--   2) markSubmitResolved() writes RESOLVED row to PendingShipment
--   3) fulfillOrderWithTracking() throws "No fulfillable orders" (non-fatal)
--   4) addOrderTag() returns 403 (non-fatal)
--   5) order is STILL unfulfilled in Shopify → next cron tick re-picks it
--   6) assertNoPriorSubmit() on entry: RESOLVED row exists → auto-delete → return
--   7) worker submits to DAC AGAIN, gets guía G2
--   8) … repeat every cron tick until the operator intervenes
--
-- The log marker for step (6) is the StepLogger INFO line written by the
-- prior shipment.ts at `apps/worker/src/dac/shipment.ts:105`:
--
--   `[submit-wait-nav] Reprocessing order <ID>: clearing prior RESOLVED
--    PendingShipment (old guía=<G1>) to allow fresh submit`
--
-- That line lands in the RunLog table (see apps/worker/src/logger.ts:30-37:
-- message = `[${step}] ${message}`, meta = `{ step, ...extra }`).
--
-- We count occurrences of that line grouped by shopifyOrderId to find
-- orders that were re-submitted, and joins up the Shopify order name via
-- the Label table for readability.
--
-- HOW TO RUN
-- ----------
-- Connect to production DB (Render "labelflow-db" → Connect → PSQL command)
-- and paste one query at a time. Queries are read-only — they never modify
-- rows. All of them are safe to re-run.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- Q1. VICTIMS:  orders that were re-submitted at least once during the
--                incident window. `reprocess_count` = number of extra DAC
--                guías minted beyond the first one.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  meta->>'priorGuia'                       AS first_prior_guia,
  COUNT(*)                                 AS reprocess_count,
  MIN("createdAt")                         AS first_reprocess_at,
  MAX("createdAt")                         AS last_reprocess_at,
  "tenantId",
  -- extract shopifyOrderId from the message body:
  --   "[submit-wait-nav] Reprocessing order 7288284610870: clearing ..."
  substring(message FROM 'Reprocessing order (\d+)') AS shopify_order_id
FROM "RunLog"
WHERE message LIKE '%Reprocessing order %clearing prior RESOLVED PendingShipment%'
  AND "createdAt" >= '2026-04-22 11:00:00+00'
  AND "createdAt" <  '2026-04-23 00:00:00+00'
GROUP BY "tenantId", shopify_order_id, first_prior_guia
ORDER BY reprocess_count DESC, first_reprocess_at ASC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Q2. JOIN TO LABEL:  readable Shopify order name + the CURRENT guía in
--                     the Label row (the LAST guía minted — the one the
--                     customer eventually gets). Compare against
--                     `first_prior_guia` from Q1 to see how many extra
--                     guías DAC billed for that order.
-- ─────────────────────────────────────────────────────────────────────────────
WITH victims AS (
  SELECT
    "tenantId",
    substring(message FROM 'Reprocessing order (\d+)') AS shopify_order_id,
    COUNT(*)                 AS reprocess_count,
    MIN(meta->>'priorGuia')  AS first_prior_guia,
    MIN("createdAt")         AS first_reprocess_at,
    MAX("createdAt")         AS last_reprocess_at
  FROM "RunLog"
  WHERE message LIKE '%Reprocessing order %clearing prior RESOLVED PendingShipment%'
    AND "createdAt" >= '2026-04-22 11:00:00+00'
    AND "createdAt" <  '2026-04-23 00:00:00+00'
  GROUP BY "tenantId", shopify_order_id
)
SELECT
  v.reprocess_count,
  l."shopifyOrderName"     AS order_name,
  v.first_prior_guia       AS first_guia_minted,
  l."dacGuia"              AS last_guia_in_db,
  l."customerName"         AS customer,
  l."customerEmail"        AS email,
  l.status                 AS label_status,
  v.first_reprocess_at,
  v.last_reprocess_at,
  v.shopify_order_id,
  v."tenantId"
FROM victims v
LEFT JOIN "Label" l
  ON l."tenantId"       = v."tenantId"
 AND l."shopifyOrderId" = v.shopify_order_id
ORDER BY v.reprocess_count DESC, v.first_reprocess_at ASC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Q3. DAC COST ESTIMATE:  rough billing exposure. Each reprocess = 1 extra
--                         DAC guía = 1 extra shipping charge.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  COUNT(DISTINCT substring(message FROM 'Reprocessing order (\d+)')) AS affected_orders,
  COUNT(*)                                                           AS extra_guias_minted,
  MIN("createdAt")                                                   AS incident_start,
  MAX("createdAt")                                                   AS incident_end
FROM "RunLog"
WHERE message LIKE '%Reprocessing order %clearing prior RESOLVED PendingShipment%'
  AND "createdAt" >= '2026-04-22 11:00:00+00'
  AND "createdAt" <  '2026-04-23 00:00:00+00';

-- ─────────────────────────────────────────────────────────────────────────────
-- Q4. SHOPIFY FULFILL FAILURES (root cause confirmation):  count of
--       "Shopify fulfillment failed (non-fatal)" log lines in the same
--       window. If this number is ≈ extra_guias_minted from Q3, then the
--       Shopify-scope hypothesis is confirmed: every failed fulfill =
--       one order that re-enters the loop.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  COUNT(*) AS shopify_fulfill_failures,
  COUNT(*) FILTER (WHERE message LIKE '%No fulfillable orders%') AS zero_fulfillment_orders,
  COUNT(*) FILTER (WHERE message LIKE '%403%')                   AS forbidden_403,
  MIN("createdAt") AS first_failure,
  MAX("createdAt") AS last_failure
FROM "RunLog"
WHERE level = 'WARN'
  AND message LIKE '%Shopify fulfillment failed (non-fatal)%'
  AND "createdAt" >= '2026-04-22 11:00:00+00'
  AND "createdAt" <  '2026-04-23 00:00:00+00';

-- ─────────────────────────────────────────────────────────────────────────────
-- Q5. PER-ORDER TIMELINE for a single suspect order.  Replace
--       <ORDER_ID> with a Shopify order ID from Q1 for a full forensic
--       trace of what happened to that specific shipment.
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT "createdAt", level, message, meta
-- FROM "RunLog"
-- WHERE (message LIKE '%<ORDER_ID>%'
--        OR meta->>'orderName' = '#<ORDER_NAME>'
--        OR meta->>'orderId'   = '<ORDER_ID>')
--   AND "createdAt" >= '2026-04-22 11:00:00+00'
-- ORDER BY "createdAt" ASC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Q6. POST-HOTFIX VERIFICATION:  after e03b024 deploys, the log line
--       changes to "Refusing to re-submit order … RESOLVED PendingShipment
--       is still recent". Count those to confirm the guard is firing
--       instead of allowing the duplicate.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  COUNT(*)                                          AS block_events,
  COUNT(DISTINCT substring(message FROM 'order (\d+):')) AS distinct_orders_blocked,
  MIN("createdAt")                                  AS first_block,
  MAX("createdAt")                                  AS last_block
FROM "RunLog"
WHERE message LIKE '%Refusing to re-submit order %RESOLVED PendingShipment is still recent%'
  AND "createdAt" >= '2026-04-22 11:00:00+00';
