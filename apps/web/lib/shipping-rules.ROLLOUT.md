# Shipping Rules — rollout notes

Author: 2026-04-19

## Summary

New first-match-wins rule engine that decides REMITENTE vs DESTINATARIO per
order, replacing the hard-coded `paymentThreshold + consolidation` logic for
tenants that opt in (zero-config tenants keep their current behavior).

Rule types: `THRESHOLD_TOTAL`, `CONSECUTIVE_ORDERS`, `NTH_SHIPMENT_FREE`,
`CUSTOMER_TAG`, `ITEM_COUNT`.

## Files shipped

### Database
- `apps/web/prisma/schema.prisma` — `ShippingRule` model + `ShippingRuleType` enum + `Tenant.shippingRules` relation
- `apps/worker/prisma/schema.prisma` — same changes (both apps read the same DB)

### Worker (rule engine)
- `apps/worker/src/rules/shipping.ts` — evaluator + matchers + config validators (new)
- `apps/worker/src/jobs/process-orders.job.ts` — integrated (evaluator runs first; legacy path as fallback)
- `apps/worker/src/jobs/process-orders-bulk.job.ts` — same integration
- `apps/worker/src/__tests__/shipping-rules.test.ts` — 28 unit tests covering edges + defensive behavior

### Web app
- `apps/web/lib/shipping-rules.ts` — Zod validators + labels (shared between UI + API)
- `apps/web/app/api/v1/shipping-rules/route.ts` — GET (list) + POST (create)
- `apps/web/app/api/v1/shipping-rules/[id]/route.ts` — PUT + DELETE
- `apps/web/app/api/v1/shipping-rules/reorder/route.ts` — bulk priority reorder (transactional)
- `apps/web/app/(dashboard)/settings/shipping-rules/page.tsx` — CRUD UI (list + modal + reorder)
- `apps/web/components/layout/Sidebar.tsx` — added "Reglas de envio" nav link

## Rollout steps

1. **Push schema to DB** (project uses `db push`, not migrations):
   ```
   cd apps/web && npx prisma db push
   cd apps/worker && npx prisma generate
   ```
   Both apps point at the same Postgres — only one `db push` needed.

2. **Deploy worker to Render** (or whichever env runs `dist/`):
   - The worker includes a defensive fallback: if a tenant has no rules OR no
     rule matches, it runs the legacy `determinePaymentType + consolidation`
     path exactly as before. Safe to deploy before any tenant has rules.

3. **Deploy web app** (Vercel / your Next.js host):
   - New routes are tenant-scoped via `getAuthenticatedTenant`; no public
     exposure. API enforces max 50 rules per tenant.

4. **Pilot tenant enables a rule** from `/settings/shipping-rules`.
   - First rule to try: `THRESHOLD_TOTAL` with `minTotalUyu` equal to the
     tenant's current `paymentThreshold`. Behavior should be identical to
     today, which is a good smoke test.
   - Confirm by running the cron once (or using the "Procesar ahora" button)
     and checking worker logs for `ShippingRule matched → REMITENTE`.

## Backward compatibility guarantees

- Zero rules → evaluator returns `null` immediately → legacy path runs → **no behavior change**.
- Rules exist but none match → same fallback.
- A rule with an **invalid config** is logged and skipped (never matches).
- A matcher that **throws** (e.g., DB hiccup) is logged and the engine moves on to the next rule. Tested.
- The legacy `paymentThreshold`, `paymentRuleEnabled`, `consolidateConsecutiveOrders`, `consolidationWindowMinutes` settings are **unchanged** and still authoritative when the rule engine abstains.

## What the dashboard gives the user

Everything asked for on 2026-04-19:

- ✅ "Si un usuario hace dos envíos seguidos" → **CONSECUTIVE_ORDERS** with `windowMinutes`.
- ✅ "Cuánto precio tiene que superar el envío para que sea gratis" → **THRESHOLD_TOTAL** with `minTotalUyu` (strict greater-than, multi-currency aware).
- ✅ Plus three more dimensions requested as "absolutamente todo":
  - **NTH_SHIPMENT_FREE** — loyalty rewards every Nth shipment
  - **CUSTOMER_TAG** — Shopify tag-based overrides (case-insensitive match on order.tags or customer.tags)
  - **ITEM_COUNT** — bulk-order override

- Per-rule: `priority` (lower = evaluated first), `isActive` toggle, full CRUD.
- Reorderable by move-up/down (single transactional renumber).
- Tenant-scoped throughout; no cross-tenant leakage.

## Verification done before handoff

- `tsc --noEmit` on both `apps/web` and `apps/worker`: 0 errors.
- `vitest run src/__tests__/shipping-rules.test.ts`: 28/28 pass (edges, priority, first-match-wins, invalid configs, thrown matchers, boundary equality, currency conversion, email-less orders, tag parsing).
- The existing `payment.test.ts` still runs unchanged (legacy path intact).

## Known non-goals (deliberate)

- No migration to convert tenants' existing `paymentThreshold` into a THRESHOLD_TOTAL row — left to the user per tenant so the choice is deliberate.
- Reorder UI uses up/down buttons, not drag-drop — simpler, zero dependency footprint.
- No soft-delete / audit log on rules — if that becomes a compliance ask, add `deletedAt` + a `shipping_rule_audit` table.
