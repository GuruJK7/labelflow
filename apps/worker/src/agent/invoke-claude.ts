/**
 * invoke-claude.ts
 *
 * Spawns `claude -p` with the `process-bulk-dac` skill to resolve a single
 * YELLOW-classified Shopify order against DAC's /envios/normales form.
 *
 * Uses the Claude Max subscription installed on the Mac Mini — NO API key.
 * The user must have run `claude /login` once on that machine before the
 * worker starts spawning this.
 *
 * Contract (matches scripts/skills/process-bulk-dac/SKILL.md):
 *   - Writes /tmp/labelflow-order-context.json before spawn
 *   - Reads /tmp/labelflow-order-result.json after spawn
 *   - Cleans both files on exit
 *
 * One invocation per order. The outer loop is sequential in
 * agent-bulk-upload.job.ts, so the fixed paths are safe.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';

import type { AgentJobPayload } from '../jobs/process-orders-bulk.job';
import type { createStepLogger } from '../logger';

const CONTEXT_PATH = '/tmp/labelflow-order-context.json';
const RESULT_PATH = '/tmp/labelflow-order-result.json';
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/jk7/.local/bin/claude';
const DEFAULT_TIMEOUT_MS = 600_000;

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

  const context = {
    mode: debug ? 'debug' : 'escalate',
    jobId,
    labelId: entry.labelId,
    orderId: String(entry.order.id),
    orderName: entry.order.name,
    classification: entry.classification,
    order: entry.order,
    paymentType: entry.paymentType,
    dacCreds: {
      username: tenant.dacUsername,
      password: tenant.dacPassword,
    },
    senderInfo: {
      name: tenant.senderName ?? '',
      phone: '',
      address: '',
      email: tenant.senderEmail ?? '',
    },
    validDepartments: VALID_DEPARTMENTS,
    timeoutMs,
  };

  // Atomic write: tmp + rename
  const tmp = CONTEXT_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(context, null, 2), 'utf8');
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

  const result = await new Promise<ClaudeYellowResult>((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
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

  // Cleanup — always, even on failure
  await fs.unlink(CONTEXT_PATH).catch(() => {});
  await fs.unlink(RESULT_PATH).catch(() => {});

  return result;
}
