/**
 * invoke-claude.ts
 *
 * Two spawn strategies for YELLOW-classified orders on the Mac Mini.
 *
 * invokeClaudeForAddressCorrection() — active YELLOW path
 *   Spawns `claude -p` with Read+Write only. Claude reasons about ambiguous
 *   address fields (city→dept mapping, apt extraction, phone normalisation) and
 *   returns an AddressOverride. The worker then calls createShipment() with
 *   that override — Claude never touches DAC directly.
 *   Timeout: 90 s. Files: /tmp/labelflow-addr-{context,result}.json.
 *
 * invokeClaudeForYellow() — legacy path (kept for reference / A-B testing)
 *   Spawns `claude -p` with the `process-bulk-dac` Playwright skill.
 *   Claude opens its own Chromium, fills the DAC form, and returns the guía.
 *   Timeout: 600 s. Files: /tmp/labelflow-order-{context,result}.json.
 *
 * Uses the Claude Max subscription installed on the Mac Mini — NO API key.
 * The user must have run `claude /login` once on that machine.
 * One invocation per order. The outer loop is sequential so fixed /tmp
 * paths are safe within each function.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';

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
