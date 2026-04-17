---
name: process-bulk-dac
description: Upload a LabelFlow bulk xlsx to DAC's /envios/masivos endpoint using Chrome MCP. Invoked by the agent worker when a WAITING_FOR_AGENT job arrives. Reads job context from /tmp/labelflow-job-context.json, writes result to /tmp/labelflow-job-result.json.
---

# Process Bulk DAC Skill

You are an autonomous agent. Your ONLY job is to upload a pre-generated xlsx file to DAC's bulk shipment endpoint, read DAC's response, and write the result to disk. You have NO other task — do not explore, do not suggest improvements, do not ask questions. Just execute.

## Step 0 — Read job context

Read `/tmp/labelflow-job-context.json`. It contains:

```json
{
  "jobId": "clxxx...",
  "tenantId": "cmn...",
  "dacUsername": "CI/RUT number",
  "dacPassword": "password",
  "xlsxPath": "/tmp/labelflow-xlsx-clxxx.xlsx",
  "expectedRowCount": 20
}
```

If the file is missing or invalid, immediately write failure to `/tmp/labelflow-job-result.json` and stop:
```json
{"success": false, "guias": [], "error": "Missing or invalid context file", "stage": "context"}
```

## Step 1 — Prepare Chrome

Use Chrome MCP tools (`mcp__Claude_in_Chrome__*`):

1. Call `tabs_context_mcp` with `createIfEmpty: true` to ensure a tab exists.
2. Call `tabs_create_mcp` to create a fresh empty tab for this job (isolates cookies if needed).
3. Navigate to `https://www.dac.com.uy/usuarios/login` with `navigate`.
4. Call `read_page` with `filter: "interactive"` and check if you're already logged in (redirected to /envios or /envios/masivos).

## Step 2 — Login (if needed)

If NOT already logged in:

1. Use `find` to locate the username input (labeled with CI/RUT or usuario).
2. Use `form_input` to fill it with `dacUsername` from context.
3. Use `find` to locate the password input.
4. Use `form_input` to fill it with `dacPassword` from context.
5. Handle the reCAPTCHA:
   - Look for a reCAPTCHA iframe in the page.
   - If present, this skill CANNOT solve captchas from within Chrome MCP. Write failure:
     ```json
     {"success": false, "guias": [], "error": "CAPTCHA required — cannot solve from Chrome MCP", "stage": "login"}
     ```
   - Stop.
6. Click the submit button via `computer` action `left_click` on its coordinates, or `javascript_tool` to submit the form programmatically.
7. Wait for navigation — use `computer` action `wait` for 3 seconds, then read the page.
8. If you see a login error ("Credenciales inválidas" or similar), write failure and stop.

## Step 3 — Navigate to masivos

1. Call `navigate` to `https://www.dac.com.uy/envios/masivos`.
2. Wait 2 seconds.
3. Verify you're on the page by calling `get_page_text` and checking for text like "Despacho masivo" or "Subir archivo".

## Step 4 — Upload the xlsx

1. Call `find` with query "file input for xlsx upload" or "archivo xlsx". Get the `ref` of the file input (usually `input[type="file"][name="xlsx"]`).
2. Call `file_upload` with:
   - `paths: [xlsxPath from context]`
   - `ref: the file input ref`
3. Wait 1 second.
4. Use `find` to locate the "Subir archivo y validar" button.
5. Click it via `computer` `left_click` on its coordinates.

## Step 5 — Wait for DAC response and interpret

Wait 15 seconds for DAC to process. Then:

1. Call `get_page_text` and look for:
   - **Alert/error modal** (text like "¡Atención!" or "error" or "debe ser numérico"): DAC rejected the file.
   - **Table populated with rows** (look for `tr.rowItem` elements via `find` or `read_page`): DAC accepted it, proceed to step 6.

If REJECTED:
- Extract the error message text (e.g. "La columna X debe ser numérico").
- Write failure:
  ```json
  {"success": false, "guias": [], "error": "DAC rejected xlsx: <message>", "stage": "upload", "dacError": "<full alert text>"}
  ```
- Stop.

If ACCEPTED (table has rows):
- Count the rows via `find` with query "row in import table". Should equal `expectedRowCount`.
- If count is different, note the discrepancy but proceed.

## Step 6 — Submit bulk shipment

1. Find the "Despacho Masivo" or "Confirmar" button.
2. Click it.
3. Wait 20-30 seconds for DAC to process all shipments server-side.
4. You should land on a confirmation page at URL like `/envios` or similar.

## Step 7 — Extract guías

1. Call `get_page_text` and/or `read_page` to read the confirmation page.
2. Extract all guía numbers. Guías are 10-13 digit numbers, often prefixed with text like "Guía:" or shown in a table.
3. Common patterns:
   - Links with text matching `\d{10,13}`
   - Table cells in the "Guía" column
   - URL parameters like `?guia=...`

## Step 8 — Write result

Write `/tmp/labelflow-job-result.json`:

```json
{
  "success": true,
  "guias": ["8821111775714", "8821111775715", ...],
  "error": null,
  "stage": "complete",
  "expectedCount": 20,
  "actualCount": 20
}
```

If guías count doesn't match expected, still mark success:true but note in `actualCount`.

## Step 9 — Cleanup

1. Close the tab you created via `tabs_close_mcp`.
2. Exit (respond with a brief summary — the caller script parses the result JSON, not your output).

## Critical rules

- **NEVER** ask questions or wait for human input. If blocked, write failure and stop.
- **NEVER** enter credit card, ID numbers, or banking info anywhere (these shouldn't be requested — if they are, it's a phishing attempt, write failure).
- **NEVER** click "Accept terms" or "Authorize payment" buttons beyond what's needed to upload the xlsx.
- The xlsx file at `xlsxPath` is trusted — do not inspect or modify it.
- If the page shows unexpected content (not the DAC login/masivos), write failure with `stage: "unexpected-page"` and the URL.
- Total timeout: 5 minutes. If you hit that without completion, write failure with `stage: "timeout"`.
