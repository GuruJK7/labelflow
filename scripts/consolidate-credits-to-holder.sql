-- One-shot consolidation: move every multi-tenant user's credits onto
-- their CREDIT-HOLDER tenant (the oldest one). Audit 2026-05-08 — see
-- apps/web/lib/credit-holder.ts for the architecture.
--
-- Effect (per multi-tenant user):
--   1. SUM all of the user's tenants' shipmentCredits / referralBonusCredits
--      / creditsPurchased / creditsConsumed / referralCreditsEarned
--   2. Stamp the SUM onto the holder (oldest tenant by createdAt,id)
--   3. Zero out those columns on every NON-holder tenant
--
-- Idempotent: safe to re-run. After the first run, non-holder tenants
-- already have zeros, so the second pass adds 0 to the holder.
--
-- Single-tenant users are unaffected (they're already their own holder).
--
-- Run UNA SOLA VEZ contra production:
--   psql "$DIRECT_URL" -f scripts/consolidate-credits-to-holder.sql
--
-- Verification post-run (debe devolver 0 filas con saldo en non-holders):
--   SELECT t.id, t.name, t."shipmentCredits", t."referralBonusCredits"
--   FROM "Tenant" t
--   JOIN (
--     SELECT "userId", MIN(("createdAt", id)::text) AS holder_key
--     FROM "Tenant"
--     GROUP BY "userId"
--     HAVING COUNT(*) > 1
--   ) h ON h."userId" = t."userId"
--   WHERE (t."createdAt", t.id)::text > h.holder_key
--     AND (t."shipmentCredits" > 0 OR t."referralBonusCredits" > 0);

BEGIN;

-- Step 1: identify, per user, the holder tenant and the rows to drain.
WITH ranked AS (
  SELECT
    t.id,
    t."userId",
    t."shipmentCredits",
    t."referralBonusCredits",
    t."creditsPurchased",
    t."creditsConsumed",
    t."referralCreditsEarned",
    ROW_NUMBER() OVER (
      PARTITION BY t."userId"
      ORDER BY t."createdAt" ASC, t.id ASC
    ) AS rn
  FROM "Tenant" t
),
sums AS (
  SELECT
    "userId",
    SUM(CASE WHEN rn > 1 THEN "shipmentCredits"        ELSE 0 END)::int AS sum_shipment,
    SUM(CASE WHEN rn > 1 THEN "referralBonusCredits"   ELSE 0 END)::int AS sum_bonus,
    SUM(CASE WHEN rn > 1 THEN "creditsPurchased"       ELSE 0 END)::int AS sum_purchased,
    SUM(CASE WHEN rn > 1 THEN "creditsConsumed"        ELSE 0 END)::int AS sum_consumed,
    SUM(CASE WHEN rn > 1 THEN "referralCreditsEarned"  ELSE 0 END)::int AS sum_ref_earned,
    MAX(CASE WHEN rn = 1 THEN id END)                                 AS holder_id
  FROM ranked
  GROUP BY "userId"
  HAVING COUNT(*) > 1
)
-- Snapshot before the move so we can audit it (logged via psql output).
SELECT
  s."userId",
  s.holder_id,
  s.sum_shipment      AS draining_shipment,
  s.sum_bonus         AS draining_bonus,
  s.sum_purchased     AS draining_purchased,
  s.sum_consumed      AS draining_consumed,
  s.sum_ref_earned    AS draining_ref_earned
FROM sums s
ORDER BY s."userId";

-- Step 2: add the non-holder sums onto each holder.
UPDATE "Tenant" h
SET
  "shipmentCredits"      = h."shipmentCredits"      + s.sum_shipment,
  "referralBonusCredits" = h."referralBonusCredits" + s.sum_bonus,
  "creditsPurchased"     = h."creditsPurchased"     + s.sum_purchased,
  "creditsConsumed"      = h."creditsConsumed"      + s.sum_consumed,
  "referralCreditsEarned"= h."referralCreditsEarned"+ s.sum_ref_earned,
  "updatedAt"            = NOW()
FROM (
  WITH ranked AS (
    SELECT
      t.id,
      t."userId",
      t."shipmentCredits",
      t."referralBonusCredits",
      t."creditsPurchased",
      t."creditsConsumed",
      t."referralCreditsEarned",
      ROW_NUMBER() OVER (
        PARTITION BY t."userId"
        ORDER BY t."createdAt" ASC, t.id ASC
      ) AS rn
    FROM "Tenant" t
  )
  SELECT
    "userId",
    SUM(CASE WHEN rn > 1 THEN "shipmentCredits"        ELSE 0 END)::int AS sum_shipment,
    SUM(CASE WHEN rn > 1 THEN "referralBonusCredits"   ELSE 0 END)::int AS sum_bonus,
    SUM(CASE WHEN rn > 1 THEN "creditsPurchased"       ELSE 0 END)::int AS sum_purchased,
    SUM(CASE WHEN rn > 1 THEN "creditsConsumed"        ELSE 0 END)::int AS sum_consumed,
    SUM(CASE WHEN rn > 1 THEN "referralCreditsEarned"  ELSE 0 END)::int AS sum_ref_earned,
    MAX(CASE WHEN rn = 1 THEN id END)                                 AS holder_id
  FROM ranked
  GROUP BY "userId"
  HAVING COUNT(*) > 1
) s
WHERE h.id = s.holder_id;

-- Step 3: zero out the non-holder tenants for every multi-tenant user.
UPDATE "Tenant" t
SET
  "shipmentCredits"       = 0,
  "referralBonusCredits"  = 0,
  "creditsPurchased"      = 0,
  "creditsConsumed"       = 0,
  "referralCreditsEarned" = 0,
  "updatedAt"             = NOW()
WHERE t.id IN (
  WITH ranked AS (
    SELECT
      id,
      "userId",
      ROW_NUMBER() OVER (
        PARTITION BY "userId"
        ORDER BY "createdAt" ASC, id ASC
      ) AS rn
    FROM "Tenant"
  )
  SELECT id FROM ranked WHERE rn > 1
);

-- Verification: non-holders for multi-tenant users must all be zero now.
SELECT COUNT(*) AS non_holder_rows_with_balance
FROM "Tenant" t
WHERE EXISTS (
  WITH ranked AS (
    SELECT
      id,
      "userId",
      ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "createdAt" ASC, id ASC) AS rn
    FROM "Tenant"
  )
  SELECT 1 FROM ranked r WHERE r.id = t.id AND r.rn > 1
)
AND (
  t."shipmentCredits"      > 0 OR
  t."referralBonusCredits" > 0 OR
  t."creditsPurchased"     > 0 OR
  t."creditsConsumed"      > 0 OR
  t."referralCreditsEarned" > 0
);

COMMIT;
