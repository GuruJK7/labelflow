// Bridge-first Claude invocation helper for the worker's two API-only AI
// callers: dac/ai-feasibility.ts and dac/ai-resolver.ts. The existing
// invokeClaudeViaBridge in agent/invoke-claude.ts is YELLOW-correction-shaped
// (assumes a fixed prompt template) and only handles `resolveAddressCorrection`.
// This helper is the GENERIC equivalent — caller passes system + user + an
// expected JSON shape and gets a parsed object back.
//
// Behavior:
//   1. If LABELFLOW_BRIDGE_URL + LABELFLOW_BRIDGE_SECRET are set, POST to the
//      Mac Mini bridge's /claude-prompt endpoint. Subscription-backed → $0.
//   2. On any non-2xx, timeout, parse failure, or schema mismatch return null
//      so the CALLER can fall back to its existing Anthropic SDK code path.
//   3. On 'unresolvable' (caller's schema validator returns null) we treat it
//      as a real "Claude refused" answer and propagate null too — the caller
//      decides what to do (typically the same as a transient error).
//
// We deliberately do NOT throw. The caller's existing API code path is the
// safety net; this helper only short-circuits to the bridge when the bridge
// is healthy AND returns a parseable result.

import logger from '../logger';

const BRIDGE_DEFAULT_TIMEOUT_MS = 180_000; // matches the bridge's spawn timeout

export type CallClaudeJSONInput = {
  /** Job/order ids — used by the bridge for log correlation only. */
  jobId?: string;
  orderId?: string | number;
  /** System prompt (use the same one the SDK would receive). */
  system: string;
  /** User message (use the same one the SDK would receive). */
  user: string;
  /** Claude model name (haiku/sonnet/opus). Default 'haiku' to match SDK callers. */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Tool subset the bridge should pass to `claude -p`. Default 'Read,Write'.
   * Use 'Read,Write,WebSearch,WebFetch,Bash' when the call benefits from
   * online research (e.g. the resolver's address lookup path). */
  allowedTools?: string;
  /** Optional human-readable schema description appended to the prompt to
   * coax Claude into emitting a parseable shape. */
  schemaHint?: string;
};

type BridgeClaudePromptResponse =
  | { ok: true; content: unknown }
  | { ok: false; error: string; detail?: string };

/**
 * Try to run a structured-JSON Claude call through the Mac Mini bridge.
 * Returns the parsed object on success, or null on any kind of failure
 * (env not configured, network, non-2xx, JSON parse error). Callers MUST
 * have an Anthropic SDK fallback for null returns — the bridge is opt-in.
 */
export async function callClaudeJSONViaBridge(
  input: CallClaudeJSONInput,
): Promise<unknown | null> {
  const url = process.env.LABELFLOW_BRIDGE_URL;
  const secret = process.env.LABELFLOW_BRIDGE_SECRET;
  if (!url || !secret) return null;

  const timeoutMs =
    Number(process.env.LABELFLOW_BRIDGE_TIMEOUT_MS) || BRIDGE_DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
      logger.warn(
        { jobId: input.jobId, orderId: input.orderId, status: res.status },
        'bridge /claude-prompt non-2xx — falling back to API',
      );
      return null;
    }

    const body = (await res.json()) as BridgeClaudePromptResponse;
    if (!body.ok) {
      logger.warn(
        { jobId: input.jobId, orderId: input.orderId, error: body.error, detail: body.detail },
        'bridge returned ok:false — falling back to API',
      );
      return null;
    }
    return body.content;
  } catch (err) {
    const e = err as Error;
    logger.warn(
      {
        jobId: input.jobId,
        orderId: input.orderId,
        error: e.message,
        aborted: e.name === 'AbortError',
      },
      'bridge /claude-prompt threw — falling back to API',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
