---
name: process-bulk-dac
description: Claude skill reserved for Phase 2 escalation of YELLOW orders (ambiguous addresses) and auto-verification (screenshot compare). NOT invoked in Phase 1.
---

# process-bulk-dac — Reserved for Phase 2

**Status (2026-04-17):** Not yet invoked. Placeholder for the Phase 2
intelligence layer.

## Phase 1 (current)

The Mac agent (`apps/worker/src/jobs/agent-bulk-upload.job.ts`) processes
every GREEN and YELLOW order with a pure Playwright flow — no Claude spawn.
RED orders are marked `NEEDS_REVIEW` on the Render side by the classifier
(`apps/worker/src/rules/order-classifier.ts`).

You can verify this by reading `agentBulkUploadJob` — there is no `claude -p`
spawn anywhere.

The original bulk xlsx upload approach (which this skill was originally
written for) is abandoned: DAC's `/envios/masivos` endpoint has a confirmed
server-side bug that rejects any xlsx with 2+ rows, regardless of format
(tested with 13 variants across SheetJS, ExcelJS, and LibreOffice).

## Phase 2 (planned)

This skill will be invoked in two cases:

1. **YELLOW escalation** — when the deterministic Playwright flow fails on a
   YELLOW order (ambiguous city not in `dac-geo-map.json`, apt/piso mixed into
   address1, phone off-format, etc.), spawn Claude Code with this skill so it
   can:
   - Inspect the DAC form state via screenshot
   - Choose the correct city / barrio / oficina dropdown by reasoning over
     the Shopify address string
   - Fill in observaciones cleanly

2. **Auto-verification** — after each successful shipment, take a screenshot
   of DAC's confirmation page and ask Claude to compare it against the
   expected order data (name, address, guía printed, correct department).
   If Claude detects a mismatch, the label is rolled back to
   `NEEDS_REVIEW` and the tenant is emailed.

## Contract (Phase 2)

The orchestrator (`agent-bulk-upload.job.ts`) will write context to
`/tmp/labelflow-job-context.json`:

```json
{
  "mode": "escalate" | "verify",
  "orderId": "<shopify id>",
  "labelId": "<label id>",
  "classification": { "zone": "YELLOW", "reasons": ["UNKNOWN_CITY"] },
  "order": { "...": "full ShopifyOrder object" },
  "screenshotPath": "/tmp/labelflow-verify-<jobId>-<i>.png"
}
```

And read the result from `/tmp/labelflow-job-result.json`:

```json
{
  "success": true,
  "guia": "D0012345",
  "error": null,
  "confidence": "high",
  "reasoning": "..."
}
```

## Why the name didn't change

The skill directory stays named `process-bulk-dac` to avoid churn in the
`setup-adrian-mac.sh` script path. When Phase 2 lands, the SKILL.md content
will be expanded with the full prompt, but the directory name stays.
