---
name: process-bulk-dac
description: Process a single YELLOW-classified Shopify order against DAC's /envios/normales form using Playwright MCP. Resolves ambiguous data (unknown city, weird phone, apt in address1, department mismatch) with careful reasoning over Uruguay's geography and DAC's dropdown constraints. Returns the extracted guía or a structured error.
---

# process-bulk-dac — Per-order YELLOW escalation (Phase 2)

You are the fallback intelligence for LabelFlow. A Shopify order was classified
as **YELLOW** by the deterministic pipeline, meaning it is shippable but has
ambiguous non-critical data that a hard-coded Playwright script cannot resolve
reliably. The worker on Adrian's Mac has spawned you to complete the DAC
shipment by reasoning over the Shopify address and DAC's form constraints.

## Your job in one sentence

Read the context JSON, log into DAC, fill the `/envios/normales` form correctly,
submit it, extract the guía from the confirmation, write the result JSON. Exit.

## Contract

### Input — you MUST read this file first

Path: `/tmp/labelflow-order-context.json`

```json
{
  "mode": "escalate",
  "jobId": "cmo50jws1000110fjfatneen3",
  "labelId": "cmo50jxyz...",
  "orderId": "8821117591810",
  "orderName": "#1196",
  "classification": {
    "zone": "YELLOW",
    "reasons": ["UNKNOWN_CITY", "APT_IN_ADDRESS1"],
    "summary": "Ambiguous but shippable: UNKNOWN_CITY, APT_IN_ADDRESS1"
  },
  "order": {
    "id": 8821117591810,
    "name": "#1196",
    "total_price": "1250.00",
    "currency": "UYU",
    "shipping_address": {
      "first_name": "Veronique",
      "last_name": "Muracciole",
      "address1": "Roosevelt s/nesquina pedragosa sierra, local 5",
      "address2": "jorge martinez",
      "city": "maldonado",
      "province": "Maldonado",
      "country": "Uruguay",
      "phone": "099888777"
    }
  },
  "paymentType": "DESTINATARIO",
  "dacCreds": {
    "username": "49665891",
    "password": "<plaintext>"
  },
  "senderInfo": {
    "name": "Adrian Spinelli Lemo",
    "phone": "+59899999999",
    "address": "calle x 1234, montevideo",
    "email": "adrian@example.com"
  },
  "validDepartments": ["Montevideo", "Canelones", "Maldonado", "Rocha", "Colonia", "San Jose", "Florida", "Durazno", "Flores", "Lavalleja", "Treinta y Tres", "Cerro Largo", "Rivera", "Artigas", "Salto", "Paysandu", "Rio Negro", "Soriano", "Tacuarembo"],
  "timeoutMs": 180000
}
```

The worker will have written this file atomically before spawning you. It is
safe to assume the file exists, is valid JSON, and has all fields above.
**Do not ask the user for clarifying information. All inputs are in the JSON.**

### Output — you MUST write this file before exiting

Path: `/tmp/labelflow-order-result.json`

Success:
```json
{
  "success": true,
  "guia": "8821117591810",
  "trackingUrl": "https://www.dac.com.uy/tracking/?guia=8821117591810",
  "confidence": "high",
  "reasoning": "City 'maldonado' → department Maldonado (official). Apt moved from address1 to observaciones. Phone normalized to 099888777.",
  "formFieldsFilled": {
    "department": "Maldonado",
    "city": "Maldonado",
    "address1": "Roosevelt s/n esquina Pedragosa Sierra",
    "observaciones": "local 5, jorge martinez",
    "phone": "099888777"
  }
}
```

Failure (unrecoverable — worker will mark label FAILED):
```json
{
  "success": false,
  "guia": null,
  "error": "DAC returned error: 'La ciudad no coincide con el departamento'",
  "reasoning": "Tried 'Maldonado' twice, DAC rejected. No alternative spelling in dropdown. Manual review needed.",
  "formFieldsFilled": { ... partial state ... }
}
```

## How to operate

1. **Read** `/tmp/labelflow-order-context.json` with the `Read` tool.
2. **Launch Chromium** via the `playwright` MCP server (`browser_navigate` tool)
   to `https://www.dac.com.uy/login`.
3. **Login** using `dacCreds.username` and `dacCreds.password`. Fill the form
   fields by inspecting the DOM with `browser_snapshot`; never rely on fixed
   selectors — DAC may change them without notice.
4. **Navigate** to the `/envios/normales` form (or equivalent "Agregar envío"
   flow you find after login).
5. **Fill the form step by step**:
   - **Tipo de envío**: choose the option matching `paymentType`
     (`REMITENTE` → "Paga remitente" / `DESTINATARIO` → "Paga destino")
   - **Origen / Remitente**: use `senderInfo` fields
   - **Destinatario**:
     - Name: `order.shipping_address.first_name + last_name`
     - Address (calle y número): **strip apartment/floor/piso markers from
       `address1`** and move them to observaciones. Example: `"Roosevelt s/n
       esquina Pedragosa Sierra, local 5"` → address1 becomes `"Roosevelt s/n
       esquina Pedragosa Sierra"`, observaciones gets `"local 5"`.
     - **Department**: use the DAC dropdown. If `shipping_address.province`
       matches a valid department from `validDepartments`, use it. Otherwise
       infer from `city` (e.g. "maldonado" → "Maldonado"). **Never submit a
       department not in `validDepartments`.**
     - **City**: pick from the DAC city dropdown for that department. If the
       exact name is not in the dropdown, pick the closest match and record
       the mismatch in `reasoning`.
     - Phone: normalize to digits only. If `phone` is empty or clearly invalid
       (< 7 digits), use `"00000000"` as DAC fallback and flag it in reasoning.
     - Observaciones: concatenate `address2` + extracted apt/floor markers.
   - **Pago**: set as specified by `paymentType`.
6. **Submit** the form. DAC will either:
   - Show a confirmation with the new guía (8+ digits) → **success**
   - Show a validation error → read the error text, decide if it's recoverable
     (e.g. dropdown wrong — retry with adjusted values, max 2 retries) or
     unrecoverable (e.g. "no credit", "duplicate guía") → **failure**
7. **Extract the guía** from the confirmation page. It is typically a string
   of 10–13 digits shown prominently. Use `browser_evaluate` if needed to read
   `document.body.innerText` and regex for the guía pattern.
8. **Write the result JSON** (`/tmp/labelflow-order-result.json`) with the
   structure above. Be verbose in `reasoning` — the worker logs it and the
   tenant sees it in the dashboard.
9. **Close the browser** (`browser_close`) cleanly.
10. Exit.

## Safety rules (CRITICAL — do not violate)

- **Never** change the `paymentType` without explicit instruction. If the
  classification says `DESTINATARIO`, the customer pays; submitting as
  `REMITENTE` charges the wrong party.
- **Never** submit a department not in `validDepartments`. DAC will accept it
  silently and the package will be misrouted.
- **Never** invent a guía. If you cannot extract one from the confirmation
  page after submission, return `success: false`.
- **Never** process more than 1 order per invocation. This skill is per-order;
  the worker loops externally.
- **Never** skip writing `/tmp/labelflow-order-result.json`. The worker waits
  for this file; if it's missing, the order is marked FAILED with a "skill
  timeout" error.
- **Do not** use the `chrome-devtools` MCP or any other browser automation —
  only `playwright` MCP. Other MCPs are not audited for this flow.
- **Do not** make any HTTP calls to shopify, supabase, or any service other
  than DAC. The worker handles those.

## Timeouts

You have `timeoutMs` (default 180000ms = 3 min) from the moment the worker
spawns `claude -p`. After that, the worker kills your process and marks the
label FAILED. If you approach 2.5 min without a result, write a failure JSON
with `reasoning: "approaching timeout"` and exit.

## Debugging mode

If the context JSON has `"mode": "debug"` instead of `"escalate"`, do NOT
submit the form. Just fill it, take a screenshot, and write the result with
`success: false` and `reasoning: "debug mode — form filled but not submitted"`.
The screenshot path goes in `formFieldsFilled.screenshot`.
