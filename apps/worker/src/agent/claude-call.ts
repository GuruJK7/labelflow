// Bridge-first Claude invocation helper with API fallback for the worker's
// AI callers: dac/ai-feasibility.ts and dac/ai-resolver.ts.
//
// Strategy (designed 2026-05-11 after the Funnel was finally re-enabled):
//   1. Try the Mac Mini bridge first — backed by the Claude Max subscription
//      so calls cost $0 marginal.
//   2. Use a short timeout (8s) so a hung/missing bridge doesn't stall the
//      worker. The bridge's own claude CLI invocation usually finishes in
//      3-5s with haiku, so 8s is comfortable headroom; anything slower
//      means the bridge is unhealthy and we should fall back fast.
//   3. Circuit breaker: after 5 consecutive failures, skip bridge attempts
//      entirely for 2 minutes. This prevents the worker from burning ~40s
//      per AI call (8 calls × 5s timeout) when the Mac Mini is offline.
//   4. On ANY bridge failure (env unset, network, non-2xx, timeout, parse
//      error, schema mismatch) return null so the caller falls back to
//      Anthropic SDK ($0.003-0.005/call). The bridge is opt-in — null is
//      always a safe "use API instead" signal.
//
// We deliberately do NOT throw. The caller's existing Anthropic SDK code
// path is the safety net; throwing would surface bridge problems as job
// failures even though the API can answer.

import logger from '../logger';

// Bridge per-call hard timeout. Calibrated 2026-05-11 against live calls
// through Funnel: haiku /claude-prompt averages 12-17 s end-to-end (includes
// Claude CLI startup + Funnel round-trip + JSON parse). 30 s gives ~2x
// headroom over typical and still fails fast vs the bridge's internal
// 180 s budget when the Mac Mini is genuinely hung.
//
// The circuit breaker (below) makes the practical worst-case cost much
// lower: after 5 consecutive 30 s timeouts (~150 s total wall-clock) the
// breaker opens and subsequent calls return null in ~0 ms for the next
// 2 minutes — straight to API fallback.
const BRIDGE_HARD_TIMEOUT_MS = Number(process.env.LABELFLOW_BRIDGE_TIMEOUT_MS) || 30_000;

// Circuit-breaker config — when the Mac Mini is offline we want to stop
// trying for a while instead of burning 8s on every call.
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_DURATION_MS = 2 * 60_000; // 2 min

// Module-level circuit state. Per-process — multiple Render instances each
// track their own circuit independently, which is fine for our scale.
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function circuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

function recordBridgeSuccess(): void {
  if (consecutiveFailures > 0) {
    logger.info(
      { previousFailures: consecutiveFailures },
      'bridge: success after failures — circuit closes',
    );
  }
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

function recordBridgeFailure(reason: string): void {
  consecutiveFailures++;
  if (consecutiveFailures === CIRCUIT_FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS;
    logger.warn(
      {
        consecutiveFailures,
        circuitOpenForMs: CIRCUIT_OPEN_DURATION_MS,
        lastReason: reason,
      },
      'bridge: circuit OPEN — skipping bridge for 2 min, falling straight to API',
    );
  }
}

/** Test-only — reset the circuit-breaker between unit tests. */
export function _resetCircuitBreakerForTests(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

export type CallClaudeJSONInput = {
  /** Job/order ids — used by the bridge for log correlation only. */
  jobId?: string;
  orderId?: string | number;
  /** System prompt (use the same one the SDK would receive). */
  system: string;
  /** User message (use the same one the SDK would receive). */
  user: string;
  /** Claude model name. Default 'haiku' to match SDK callers. */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Tool subset the bridge should pass to `claude -p`. Default 'Read,Write'. */
  allowedTools?: string;
  /** Optional human-readable schema description appended to the prompt. */
  schemaHint?: string;
};

type BridgeClaudePromptResponse =
  | { ok: true; content: unknown }
  | { ok: false; error: string; detail?: string };

/**
 * Try to run a structured-JSON Claude call through the Mac Mini bridge.
 * Returns the parsed object on success, or null on any kind of failure
 * (env not configured, network, non-2xx, JSON parse error, circuit open).
 * Callers MUST have an Anthropic SDK fallback for null returns.
 */
export async function callClaudeJSONViaBridge(
  input: CallClaudeJSONInput,
): Promise<unknown | null> {
  const url = process.env.LABELFLOW_BRIDGE_URL;
  const secret = process.env.LABELFLOW_BRIDGE_SECRET;
  if (!url || !secret) return null;

  if (circuitOpen()) {
    // Circuit is open — skip the attempt entirely. Don't even count this
    // as a failure (we already decided not to try).
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_HARD_TIMEOUT_MS);

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/claude-prompt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Labelflow-Secret': secret,
      },
      body: JSON.stringify({
        jobId: input.jobId ?? '',
        orderId: input.orderId !== undefined ? String(input.orderId) : '',
        model: input.model ?? 'haiku',
        allowedTools: input.allowedTools ?? 'Read,Write',
        responseFormat: 'json',
        system: input.system,
        user: input.user,
        schemaHint: input.schemaHint,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      recordBridgeFailure(`http-${res.status}`);
      logger.warn(
        { jobId: input.jobId, orderId: input.orderId, status: res.status },
        'bridge /claude-prompt non-2xx — falling back to API',
      );
      return null;
    }

    const body = (await res.json()) as BridgeClaudePromptResponse;
    if (!body.ok) {
      recordBridgeFailure(`bridge-${body.error}`);
      logger.warn(
        { jobId: input.jobId, orderId: input.orderId, error: body.error, detail: body.detail },
        'bridge returned ok:false — falling back to API',
      );
      return null;
    }
    recordBridgeSuccess();
    return body.content;
  } catch (err) {
    const e = err as Error;
    const reason = e.name === 'AbortError' ? 'timeout' : `error-${e.name}`;
    recordBridgeFailure(reason);
    logger.warn(
      {
        jobId: input.jobId,
        orderId: input.orderId,
        error: e.message,
        aborted: e.name === 'AbortError',
        timeoutMs: BRIDGE_HARD_TIMEOUT_MS,
      },
      'bridge /claude-prompt threw — falling back to API',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
