/**
 * invoke-claude.ts
 *
 * Strategies for YELLOW-classified orders.
 *
 * resolveAddressCorrection() — the public dispatcher used by jobs.
 *   Tries, in order:
 *     1. Tailscale bridge (Mac Mini Claude Max, $0)       [prod primary]
 *     2. Anthropic API (haiku via SDK)                    [prod fallback]
 *     3. Local CLI spawn (for dev on the Mac Mini itself) [dev/local]
 *   Falls through on any failure (network, timeout, non-2xx, missing env).
 *   Returns null if ALL strategies fail → caller marks order NEEDS_REVIEW.
 *
 * invokeClaudeForAddressCorrection() — legacy CLI-spawn path, unchanged.
 *   Kept for unit-test compatibility and as the local-dev fallback strategy.
 *   Spawns `claude -p` with Read+Write only, reads the result JSON.
 *
 * invokeClaudeForYellow() — earliest path (kept for reference / A-B testing).
 *   Spawns `claude -p` with the `process-bulk-dac` Playwright skill where
 *   Claude drives the DAC form itself. Not used in the current flow.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import Anthropic from '@anthropic-ai/sdk';

import type { AgentJobPayload } from '../jobs/process-orders-bulk.job';
import type { createStepLogger } from '../logger';
import type { AddressOverride } from '../dac/shipment';

const CONTEXT_PATH = '/tmp/labelflow-order-context.json';
const RESULT_PATH = '/tmp/labelflow-order-result.json';
const ADDRESS_CONTEXT_PATH = '/tmp/labelflow-addr-context.json';
const ADDRESS_RESULT_PATH = '/tmp/labelflow-addr-result.json';
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/jk7/.local/bin/claude';
const DEFAULT_TIMEOUT_MS = 600_000;
const ADDRESS_CORRECTION_TIMEOUT_MS = 90_000;

const VALID_DEPARTMENTS = [
  'Montevideo', 'Canelones', 'Maldonado', 'Rocha', 'Colonia',
  'San Jose', 'Florida', 'Durazno', 'Flores', 'Lavalleja',
  'Treinta y Tres', 'Cerro Largo', 'Rivera', 'Artigas',
  'Salto', 'Paysandu', 'Rio Negro', 'Soriano', 'Tacuarembo',
];

type Entry = AgentJobPayload['orders'][number];
type StepLogger = ReturnType<typeof createStepLogger>;

export interface ClaudeYellowResult {
  success: boolean;
  guia?: string;
  trackingUrl?: string;
  error?: string;
  reasoning?: string;
  confidence?: 'high' | 'medium' | 'low' | string;
  formFieldsFilled?: Record<string, unknown>;
}

export interface InvokeClaudeParams {
  entry: Entry;
  tenant: {
    id: string;
    dacUsername: string;
    dacPassword: string; // already decrypted plaintext
    // Best-effort sender info from existing tenant fields. DAC auto-fills
    // "Origen/Remitente" from the logged-in account, so these are cosmetic
    // for the skill's reasoning/logging but safe to leave empty.
    senderName: string | null;
    senderEmail: string | null;
  };
  jobId: string;
  slog: StepLogger;
  debug?: boolean;
  timeoutMs?: number;
}

export async function invokeClaudeForYellow(
  params: InvokeClaudeParams,
): Promise<ClaudeYellowResult> {
  const {
    entry,
    tenant,
    jobId,
    slog,
    debug = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params;

  // Clean any stale result from a previous run in the same /tmp
  await fs.unlink(RESULT_PATH).catch(() => {});

  // DAC credentials are NOT written to the context file — they are passed as
  // environment variables to the spawned claude process so they never touch
  // disk in plaintext. The skill reads them via:
  //   Bash: echo $DAC_USERNAME  /  echo $DAC_PASSWORD
  const context = {
    mode: debug ? 'debug' : 'escalate',
    jobId,
    labelId: entry.labelId,
    orderId: String(entry.order.id),
    orderName: entry.order.name,
    classification: entry.classification,
    order: entry.order,
    paymentType: entry.paymentType,
    senderInfo: {
      name: tenant.senderName ?? '',
      phone: '',
      address: '',
      email: tenant.senderEmail ?? '',
    },
    validDepartments: VALID_DEPARTMENTS,
    timeoutMs,
  };

  // Atomic write: tmp + rename. Set 0600 so only the worker process can read it.
  const tmp = CONTEXT_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(context, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, CONTEXT_PATH);

  slog.info(
    'yellow-spawn',
    `Spawning claude -p (model=sonnet, debug=${debug}) for ${entry.order.name}`,
  );

  const allowedTools = [
    'Read', 'Write', 'Bash',
    'mcp__playwright__browser_navigate',
    'mcp__playwright__browser_snapshot',
    'mcp__playwright__browser_click',
    'mcp__playwright__browser_type',
    'mcp__playwright__browser_select_option',
    'mcp__playwright__browser_press_key',
    'mcp__playwright__browser_evaluate',
    'mcp__playwright__browser_wait_for',
    'mcp__playwright__browser_take_screenshot',
    'mcp__playwright__browser_close',
  ].join(',');

  const args = [
    '-p',
    '--model', 'sonnet',
    '--allowed-tools', allowedTools,
    '--output-format', 'json',
    `Invocá la skill process-bulk-dac. Leé ${CONTEXT_PATH} y seguí al pie ` +
      `de la letra el contrato de la skill: completá el form de DAC y ` +
      `escribí el resultado final a ${RESULT_PATH}. No hagas nada más.`,
  ];

  let result: ClaudeYellowResult;
  try {
    result = await new Promise<ClaudeYellowResult>((resolve) => {
      const child = spawn(CLAUDE_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Credentials injected as env vars — never written to disk
          DAC_USERNAME: tenant.dacUsername,
          DAC_PASSWORD: tenant.dacPassword,
        },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 5000);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', async (code) => {
        clearTimeout(timer);

        if (timedOut) {
          slog.error(
            'yellow-timeout',
            `Claude spawn exceeded ${timeoutMs}ms — killed`,
          );
          resolve({
            success: false,
            error: 'timeout',
            reasoning: `Claude skill spawn exceeded ${timeoutMs}ms`,
          });
          return;
        }

        // Primary source of truth: the result JSON the skill writes
        try {
          const raw = await fs.readFile(RESULT_PATH, 'utf8');
          const parsed = JSON.parse(raw) as ClaudeYellowResult;
          slog.info(
            'yellow-result',
            `success=${parsed.success} guia=${parsed.guia ?? '—'} conf=${parsed.confidence ?? '—'}`,
          );
          resolve(parsed);
          return;
        } catch (err) {
          slog.warn(
            'yellow-noresult',
            `No result JSON (exit=${code}): ${(err as Error).message}`,
          );
        }

        // Fallback: the CLI itself may have logged something useful
        resolve({
          success: false,
          error: `claude exited ${code ?? 'null'} without writing ${RESULT_PATH}`,
          reasoning: (stderr || stdout).slice(0, 500) || 'no stderr/stdout',
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        slog.error('yellow-spawn-error', `spawn() failed: ${err.message}`);
        resolve({
          success: false,
          error: `spawn failed: ${err.message}`,
          reasoning: '',
        });
      });
    });
  } finally {
    // Always clean up temp files — even if the promise rejects
    await fs.unlink(CONTEXT_PATH).catch(() => {});
    await fs.unlink(RESULT_PATH).catch(() => {});
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Address-correction spawn (new YELLOW path)
//
// Spawns claude -p with Read+Write only. Claude reasons about the ambiguous
// address fields and returns an AddressOverride. The worker then calls
// createShipment() with that override — Claude never touches DAC directly.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaudeAddressResult {
  success: boolean;
  override?: AddressOverride;
  reasoning?: string;
  error?: string;
}

export interface InvokeClaudeForAddressCorrectionParams {
  entry: Entry;
  jobId: string;
  slog: StepLogger;
  timeoutMs?: number;
}

export async function invokeClaudeForAddressCorrection(
  params: InvokeClaudeForAddressCorrectionParams,
): Promise<AddressOverride | null> {
  const {
    entry,
    jobId,
    slog,
    timeoutMs = ADDRESS_CORRECTION_TIMEOUT_MS,
  } = params;

  await fs.unlink(ADDRESS_RESULT_PATH).catch(() => {});

  const addr = entry.order.shipping_address;
  const context = {
    jobId,
    orderId: String(entry.order.id),
    orderName: entry.order.name,
    classificationReasons: entry.classification.reasons,
    shipping_address: {
      first_name: addr?.first_name ?? '',
      last_name: addr?.last_name ?? '',
      address1: addr?.address1 ?? '',
      address2: addr?.address2 ?? '',
      city: addr?.city ?? '',
      province: addr?.province ?? '',
      zip: addr?.zip ?? '',
      phone: addr?.phone ?? '',
      country: addr?.country ?? '',
    },
    validDepartments: VALID_DEPARTMENTS,
  };

  const tmp = ADDRESS_CONTEXT_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(context, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, ADDRESS_CONTEXT_PATH);

  slog.info(
    'addr-correction-spawn',
    `Spawning claude -p for address correction on ${entry.order.name} (reasons: ${entry.classification.reasons.join(',')})`,
  );

  const prompt =
    `Read ${ADDRESS_CONTEXT_PATH}. You are correcting a Shopify shipping address for Uruguay courier DAC.\n` +
    `The order was classified YELLOW due to: ${entry.classification.reasons.join(', ')}.\n` +
    `Resolve: (1) map city to the correct DAC department from validDepartments, ` +
    `(2) strip apartment/floor markers from address1 and put them in notes, ` +
    `(3) normalize phone to 8 digits only (use "00000000" if clearly invalid).\n` +
    `Write the result to ${ADDRESS_RESULT_PATH} as JSON:\n` +
    `  Success: {"success":true,"override":{"address1":"...","notes":"...","department":"...","city":"...","phone":"..."},"reasoning":"..."}\n` +
    `  Failure: {"success":false,"reasoning":"cannot resolve — <reason>"}\n` +
    `Only include fields in override that actually need correcting. Exit after writing the file.`;

  let result!: ClaudeAddressResult;
  try {
    result = await new Promise<ClaudeAddressResult>((resolve) => {
      const child = spawn(CLAUDE_BIN, [
        '-p',
        '--model', 'haiku',
        '--allowed-tools', 'Read,Write',
        '--output-format', 'json',
        prompt,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 5000);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', async (code) => {
        clearTimeout(timer);

        if (timedOut) {
          slog.error('addr-correction-timeout', `Claude address correction exceeded ${timeoutMs}ms — killed`);
          resolve({ success: false, error: 'timeout', reasoning: `Spawn exceeded ${timeoutMs}ms` });
          return;
        }

        try {
          const raw = await fs.readFile(ADDRESS_RESULT_PATH, 'utf8');
          const parsed = JSON.parse(raw) as ClaudeAddressResult;
          slog.info(
            'addr-correction-result',
            `success=${parsed.success} reasoning="${(parsed.reasoning ?? '').substring(0, 120)}"`,
          );
          resolve(parsed);
          return;
        } catch (err) {
          slog.warn(
            'addr-correction-noresult',
            `No result JSON (exit=${code}): ${(err as Error).message}`,
          );
        }

        resolve({
          success: false,
          error: `claude exited ${code ?? 'null'} without writing result`,
          reasoning: (stderr || stdout).slice(0, 500) || 'no output',
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        slog.error('addr-correction-spawn-error', `spawn() failed: ${err.message}`);
        resolve({ success: false, error: `spawn failed: ${err.message}`, reasoning: '' });
      });
    });
  } finally {
    await fs.unlink(ADDRESS_CONTEXT_PATH).catch(() => {});
    await fs.unlink(ADDRESS_RESULT_PATH).catch(() => {});
  }

  if (!result.success || !result.override) {
    slog.warn(
      'addr-correction-failed',
      `Address correction failed: ${result.reasoning ?? result.error ?? 'unknown'}`,
    );
    return null;
  }

  return result.override;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for bridge + API strategies.
//
// The CLI path above writes the context JSON to disk because `claude -p` reads
// it with the Read tool. The bridge forwards the same context over HTTP; the
// direct-API path inlines it into the prompt. All three produce the same
// ClaudeAddressResult shape so the dispatcher doesn't care which ran.
// ─────────────────────────────────────────────────────────────────────────────

function buildAddressContext(entry: Entry, jobId: string) {
  const addr = entry.order.shipping_address;
  return {
    jobId,
    orderId: String(entry.order.id),
    orderName: entry.order.name,
    classificationReasons: entry.classification.reasons,
    shipping_address: {
      first_name: addr?.first_name ?? '',
      last_name: addr?.last_name ?? '',
      address1: addr?.address1 ?? '',
      address2: addr?.address2 ?? '',
      city: addr?.city ?? '',
      province: addr?.province ?? '',
      zip: addr?.zip ?? '',
      phone: addr?.phone ?? '',
      country: addr?.country ?? '',
    },
    validDepartments: VALID_DEPARTMENTS,
  };
}

// Shared instructions — identical semantics across strategies so a YELLOW
// order produces the same override regardless of which path ran it.
const CORRECTION_RULES =
  'You are correcting a Shopify shipping address for Uruguay courier DAC.\n' +
  'Resolve: (1) map city to the correct DAC department from validDepartments, ' +
  '(2) strip apartment/floor markers from address1 and put them in notes, ' +
  '(3) normalize phone to 8 digits only (use "00000000" if clearly invalid). ' +
  'Only include fields in override that actually need correcting.\n' +
  'Response schema (JSON):\n' +
  '  Success: {"success":true,"override":{"address1":"...","notes":"...","department":"...","city":"...","phone":"...","recipientName":"..."},"reasoning":"..."}\n' +
  '  Failure: {"success":false,"reasoning":"cannot resolve — <reason>"}';

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 1: Tailscale bridge → Mac Mini Claude Max ($0)
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_DEFAULT_TIMEOUT_MS = 120_000;

async function invokeClaudeViaBridge(
  entry: Entry,
  jobId: string,
  slog: StepLogger,
): Promise<{ outcome: 'resolved' | 'unresolvable' | 'unavailable'; override: AddressOverride | null }> {
  const url = process.env.LABELFLOW_BRIDGE_URL;
  const secret = process.env.LABELFLOW_BRIDGE_SECRET;
  if (!url || !secret) {
    return { outcome: 'unavailable', override: null };
  }

  const timeoutMs = Number(process.env.LABELFLOW_BRIDGE_TIMEOUT_MS) || BRIDGE_DEFAULT_TIMEOUT_MS;
  const context = buildAddressContext(entry, jobId);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();

  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/correct-address`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-labelflow-secret': secret,
      },
      body: JSON.stringify(context),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      slog.warn(
        'bridge-non-2xx',
        `Bridge ${res.status} ${res.statusText} in ${Date.now() - t0}ms — falling back`,
      );
      return { outcome: 'unavailable', override: null };
    }

    const parsed = (await res.json()) as ClaudeAddressResult;
    slog.info(
      'bridge-result',
      `success=${parsed.success} ms=${Date.now() - t0}`,
    );

    if (parsed.success && parsed.override) {
      return { outcome: 'resolved', override: parsed.override };
    }
    // Claude resolved the call but couldn't correct — deterministic refusal,
    // don't waste the API fallback on it.
    return { outcome: 'unresolvable', override: null };
  } catch (err) {
    slog.warn(
      'bridge-error',
      `Bridge unreachable in ${Date.now() - t0}ms: ${(err as Error).message} — falling back`,
    );
    return { outcome: 'unavailable', override: null };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 2: direct Anthropic API (haiku) — the always-available fallback
// ─────────────────────────────────────────────────────────────────────────────

const API_DEFAULT_TIMEOUT_MS = 30_000;
const API_MODEL = 'claude-haiku-4-5-20251001';

async function invokeClaudeViaAnthropicAPI(
  entry: Entry,
  jobId: string,
  slog: StepLogger,
): Promise<{ outcome: 'resolved' | 'unresolvable' | 'unavailable'; override: AddressOverride | null }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    slog.warn('api-no-key', 'ANTHROPIC_API_KEY not set — no fallback available');
    return { outcome: 'unavailable', override: null };
  }

  const timeoutMs = Number(process.env.LABELFLOW_API_TIMEOUT_MS) || API_DEFAULT_TIMEOUT_MS;
  const context = buildAddressContext(entry, jobId);

  const client = new Anthropic({ apiKey, timeout: timeoutMs });

  const system =
    CORRECTION_RULES +
    '\n\nRespond with ONLY the JSON object — no prose, no markdown fences. ' +
    'Your entire output must parse as JSON.';

  const userMessage =
    `YELLOW classification reasons: ${entry.classification.reasons.join(', ')}\n\n` +
    `Context:\n${JSON.stringify(context, null, 2)}`;

  const t0 = Date.now();
  let rawText: string;
  try {
    const resp = await client.messages.create({
      model: API_MODEL,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: userMessage }],
    });
    const block = resp.content.find((c) => c.type === 'text');
    if (!block || block.type !== 'text') {
      slog.warn('api-no-text', 'Anthropic response had no text block');
      return { outcome: 'unavailable', override: null };
    }
    rawText = block.text;
  } catch (err) {
    slog.warn(
      'api-error',
      `Anthropic API failed in ${Date.now() - t0}ms: ${(err as Error).message}`,
    );
    return { outcome: 'unavailable', override: null };
  }

  let parsed: ClaudeAddressResult;
  try {
    // Tolerate accidental ```json fences if the model adds them despite
    // the instruction not to.
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(cleaned) as ClaudeAddressResult;
  } catch (err) {
    slog.warn(
      'api-bad-json',
      `API returned non-JSON (${(err as Error).message}): ${rawText.slice(0, 200)}`,
    );
    return { outcome: 'unavailable', override: null };
  }

  slog.info(
    'api-result',
    `success=${parsed.success} ms=${Date.now() - t0}`,
  );
  if (parsed.success && parsed.override) {
    return { outcome: 'resolved', override: parsed.override };
  }
  return { outcome: 'unresolvable', override: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public dispatcher — use this from jobs.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveAddressCorrectionParams {
  entry: Entry;
  jobId: string;
  slog: StepLogger;
  timeoutMs?: number; // applies only to the CLI fallback
}

export async function resolveAddressCorrection(
  params: ResolveAddressCorrectionParams,
): Promise<AddressOverride | null> {
  const { entry, jobId, slog, timeoutMs } = params;

  // 1. Bridge (Mac Mini Claude Max, $0)
  if (process.env.LABELFLOW_BRIDGE_URL && process.env.LABELFLOW_BRIDGE_SECRET) {
    const bridge = await invokeClaudeViaBridge(entry, jobId, slog);
    if (bridge.outcome === 'resolved') return bridge.override;
    if (bridge.outcome === 'unresolvable') return null; // don't burn API on refusals
    // else 'unavailable' → try API
  }

  // 2. Anthropic API fallback
  if (process.env.ANTHROPIC_API_KEY) {
    const api = await invokeClaudeViaAnthropicAPI(entry, jobId, slog);
    if (api.outcome === 'resolved') return api.override;
    if (api.outcome === 'unresolvable') return null;
    // 'unavailable' → try CLI
  }

  // 3. Local CLI spawn (dev / running directly on the Mac Mini)
  //    This is what the existing unit tests exercise — signature unchanged.
  return invokeClaudeForAddressCorrection({ entry, jobId, slog, timeoutMs });
}
