---
name: process-bulk-dac
description: Upload a LabelFlow bulk xlsx to DAC's /envios/masivos endpoint using Playwright MCP. Invoked by the agent worker when a WAITING_FOR_AGENT job arrives. Reads job context from /tmp/labelflow-job-context.json, writes result to /tmp/labelflow-job-result.json.
---

# Process Bulk DAC Skill

You are an autonomous agent. Your ONLY job is to upload a pre-generated xlsx file to DAC's bulk shipment endpoint, read DAC's response, and write the result to disk. You have NO other task — do not explore, do not suggest improvements, do not ask questions. Just execute.

This skill requires the **Playwright MCP** server. If `mcp__playwright__*` tools are not available, write failure immediately to `/tmp/labelflow-job-result.json` with `stage: "setup"` and stop.

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

If missing or invalid, write failure and stop.

## Step 1 — Open DAC login page

Use `mcp__playwright__browser_navigate` to go to `https://www.dac.com.uy/usuarios/login`.

Wait ~2 seconds for the page to settle. Use `mcp__playwright__browser_snapshot` to see the page structure.

If you're already redirected to `/envios` (already logged in), skip to step 3.

## Step 2 — Login

1. Find the username input (labeled "Usuario", "CI", or "RUT"). Use `mcp__playwright__browser_type` to fill it with `dacUsername`.
2. Find the password input. Use `mcp__playwright__browser_type` with `dacPassword`.
3. If there's a reCAPTCHA iframe visible, this skill CANNOT solve it. Write failure:
   ```json
   {"success": false, "guias": [], "error": "CAPTCHA required — cannot solve from Playwright MCP", "stage": "login"}
   ```
   and stop. (Note: DAC typically only shows captcha on fresh IPs or after several failures.)
4. Click the submit button (Ingresar / Login / Entrar).
5. Wait for navigation. Take a snapshot to verify you're now on `/envios` or similar.
6. If you see a login error message ("Credenciales inválidas" or similar), write failure and stop.

## Step 3 — Navigate to bulk upload

Navigate to `https://www.dac.com.uy/envios/masivos`. Wait 2 seconds. Take a snapshot to confirm you're on the right page (look for "Despacho masivo" or "Subir archivo").

## Step 4 — Upload xlsx

1. Take a snapshot to find the file input (usually `input[type="file"]`).
2. Use `mcp__playwright__browser_file_upload` with the path from `xlsxPath` in context.
3. Find and click the "Subir archivo y validar" button (or similar).
4. Wait ~15 seconds for DAC to process the file.

## Step 5 — Evaluate DAC's response

Take a snapshot. Look for:

- **Error alert/modal** (text "¡Atención!" or contains "debe ser numérico" or "columna"): DAC rejected.
- **Table with data rows**: DAC accepted the file.

If REJECTED, extract the full error text from the snapshot and write:
```json
{
  "success": false,
  "guias": [],
  "error": "DAC rejected xlsx: <error message>",
  "stage": "upload",
  "dacError": "<full alert text>"
}
```
Then stop. The worker will retry or report.

If ACCEPTED (table rows visible):
- Count the rows. Should be close to `expectedRowCount`.
- Continue to step 6.

## Step 6 — Submit bulk shipment

1. Find the "Despacho Masivo" or "Confirmar" button.
2. Click it.
3. Wait 20-30 seconds for DAC to process all shipments.
4. Take a snapshot of the confirmation page.

## Step 7 — Extract guías

From the confirmation page snapshot, extract all guía numbers. Guías are 10-13 digit numbers:
- Often appear as text in table cells
- Or as links like `<a href="...?guia=8821111775714">8821111775714</a>`
- Or in URLs (after `?guia=`)

Use `mcp__playwright__browser_evaluate` with JavaScript to pull them programmatically if the snapshot is ambiguous:
```js
Array.from(document.querySelectorAll('a')).map(a => a.textContent.trim()).filter(t => /^\d{10,13}$/.test(t))
```

## Step 8 — Write result

Write `/tmp/labelflow-job-result.json`:

```json
{
  "success": true,
  "guias": ["8821111775714", "..."],
  "error": null,
  "stage": "complete",
  "expectedCount": 20,
  "actualCount": 20
}
```

## Step 9 — Cleanup

Close the browser via `mcp__playwright__browser_close`. Respond with a one-line summary (the caller reads the result JSON, not your output).

## Critical rules

- **NEVER** ask questions or wait for human input. If blocked, write failure and stop.
- **NEVER** enter credit card, ID numbers beyond CI/RUT for DAC login, or banking info.
- **NEVER** click "Accept terms" or "Authorize payment" beyond what's needed for the xlsx upload flow.
- The xlsx file at `xlsxPath` is trusted — do not inspect or modify it.
- If the page shows unexpected content (not DAC login/masivos), write failure with `stage: "unexpected-page"` and the URL.
- Total timeout: 5 minutes. If you hit that without completion, write failure with `stage: "timeout"`.
