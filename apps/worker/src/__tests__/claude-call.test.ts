// Unit tests for the bridge-first Claude call helper.
//
// The helper has two load-bearing behaviors:
//   1. 8-second hard timeout — a hung Mac Mini can't stall the cron tick.
//   2. Circuit breaker — after 5 consecutive failures the helper short-
//      circuits (returns null without even trying) for 2 minutes. This
//      prevents 8s × N waste when the Mac Mini is offline.
//
// These tests exercise the breaker by stubbing global.fetch. The 8s timeout
// isn't tested wall-clock here (would slow CI) — only its plumbing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  callClaudeJSONViaBridge,
  _resetCircuitBreakerForTests,
} from '../agent/claude-call';

const ORIGINAL_FETCH = global.fetch;

function setEnvForBridge() {
  process.env.LABELFLOW_BRIDGE_URL = 'https://example.test';
  process.env.LABELFLOW_BRIDGE_SECRET = 'test-secret';
}
function clearEnv() {
  delete process.env.LABELFLOW_BRIDGE_URL;
  delete process.env.LABELFLOW_BRIDGE_SECRET;
}

beforeEach(() => {
  _resetCircuitBreakerForTests();
  clearEnv();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  clearEnv();
  _resetCircuitBreakerForTests();
});

describe('callClaudeJSONViaBridge — config', () => {
  it('returns null when LABELFLOW_BRIDGE_URL is missing (no attempt)', async () => {
    process.env.LABELFLOW_BRIDGE_SECRET = 'test-secret';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const result = await callClaudeJSONViaBridge({
      system: 'sys', user: 'usr', model: 'haiku',
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when LABELFLOW_BRIDGE_SECRET is missing (no attempt)', async () => {
    process.env.LABELFLOW_BRIDGE_URL = 'https://example.test';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const result = await callClaudeJSONViaBridge({
      system: 'sys', user: 'usr', model: 'haiku',
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('callClaudeJSONViaBridge — happy + error paths', () => {
  it('returns the parsed content on a successful 2xx response', async () => {
    setEnvForBridge();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, content: { shippable: true, reasoning: 'ok' } }),
    }) as any;

    const result = await callClaudeJSONViaBridge({
      system: 'sys', user: 'usr', model: 'haiku',
    });

    expect(result).toEqual({ shippable: true, reasoning: 'ok' });
  });

  it('returns null on a 5xx HTTP response', async () => {
    setEnvForBridge();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 502,
      json: async () => ({}),
    }) as any;

    const result = await callClaudeJSONViaBridge({
      system: 'sys', user: 'usr', model: 'haiku',
    });

    expect(result).toBeNull();
  });

  it('returns null when bridge returns {ok:false} envelope', async () => {
    setEnvForBridge();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: 'timeout', detail: 'spawn exceeded budget' }),
    }) as any;

    const result = await callClaudeJSONViaBridge({
      system: 'sys', user: 'usr', model: 'haiku',
    });

    expect(result).toBeNull();
  });

  it('returns null when fetch itself throws (network error)', async () => {
    setEnvForBridge();
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;

    const result = await callClaudeJSONViaBridge({
      system: 'sys', user: 'usr', model: 'haiku',
    });

    expect(result).toBeNull();
  });

  it('returns null when fetch is aborted by the timeout signal', async () => {
    setEnvForBridge();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    global.fetch = vi.fn().mockRejectedValue(abortErr) as any;

    const result = await callClaudeJSONViaBridge({
      system: 'sys', user: 'usr', model: 'haiku',
    });

    expect(result).toBeNull();
  });

  it('strips trailing slash from URL when building /claude-prompt path', async () => {
    process.env.LABELFLOW_BRIDGE_URL = 'https://example.test/';
    process.env.LABELFLOW_BRIDGE_SECRET = 'test-secret';
    let capturedUrl = '';
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ ok: true, content: {} }) };
    }) as any;

    await callClaudeJSONViaBridge({ system: 's', user: 'u', model: 'haiku' });

    expect(capturedUrl).toBe('https://example.test/claude-prompt');
  });

  it('sends the secret in X-Labelflow-Secret header', async () => {
    setEnvForBridge();
    let capturedHeaders: any = null;
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      capturedHeaders = init.headers;
      return { ok: true, json: async () => ({ ok: true, content: {} }) };
    }) as any;

    await callClaudeJSONViaBridge({ system: 's', user: 'u', model: 'haiku' });

    expect(capturedHeaders['X-Labelflow-Secret']).toBe('test-secret');
    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });
});

describe('callClaudeJSONViaBridge — circuit breaker', () => {
  it('opens the circuit after 5 consecutive failures and stops calling fetch', async () => {
    setEnvForBridge();
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = fetchSpy as any;

    // 5 failures — circuit opens on the 5th
    for (let i = 0; i < 5; i++) {
      const result = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
      expect(result).toBeNull();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // 6th call — circuit is open, fetch should NOT be called
    const result = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(5); // unchanged
  });

  it('resets the failure count on a single success (circuit stays closed)', async () => {
    setEnvForBridge();
    // First 4 calls fail
    global.fetch = vi.fn().mockRejectedValue(new Error('fail')) as any;
    for (let i = 0; i < 4; i++) {
      await callClaudeJSONViaBridge({ system: 's', user: 'u' });
    }

    // 5th call succeeds — should reset counter
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: true, content: { x: 1 } }),
    }) as any;
    const ok = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
    expect(ok).toEqual({ x: 1 });

    // Now another 4 failures should NOT open the circuit (counter was reset)
    global.fetch = vi.fn().mockRejectedValue(new Error('fail')) as any;
    for (let i = 0; i < 4; i++) {
      await callClaudeJSONViaBridge({ system: 's', user: 'u' });
    }
    // Circuit should still be closed — try a success to confirm it tries
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ok: true, content: { y: 2 } }),
    });
    global.fetch = fetchSpy as any;
    const result = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
    expect(result).toEqual({ y: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // circuit was closed → attempted
  });

  it('keeps the circuit open across multiple calls during the cooldown window', async () => {
    setEnvForBridge();
    const fetchSpy = vi.fn().mockRejectedValue(new Error('fail'));
    global.fetch = fetchSpy as any;

    // Trigger 5 failures
    for (let i = 0; i < 5; i++) {
      await callClaudeJSONViaBridge({ system: 's', user: 'u' });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    // Many subsequent attempts during the 2-min window — none should hit fetch
    for (let i = 0; i < 20; i++) {
      const result = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
      expect(result).toBeNull();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});

// ── 2026-05-15 — OVERFLOW path (429 is healthy "busy", not a failure) ────────
//
// The bridge's MAX_INFLIGHT mutex returns 429 when more concurrent requests
// arrive than the Mac Mini can spawn at once. That's the bridge working
// CORRECTLY — the worker just needs to fall through to the API for that one
// call. Counting 429 as a circuit failure would mean: a brief burst (5
// concurrent tenants firing in the same second) opens the circuit and then
// the worker sends EVERYTHING to the API for the next 2 min, defeating the
// whole point of the bridge.
describe('callClaudeJSONViaBridge — overflow (429 ≠ circuit failure)', () => {
  it('returns null on 429 but does NOT count toward the circuit breaker', async () => {
    setEnvForBridge();
    // Twenty 429s in a row — way past CIRCUIT_FAILURE_THRESHOLD=5
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'busy' }),
    }) as any;

    for (let i = 0; i < 20; i++) {
      const result = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
      expect(result).toBeNull(); // caller falls back to API for THIS call
    }

    // Circuit should still be closed — verify by making a successful call.
    // If 429s had counted, after 5 the circuit would be open and the next
    // fetch wouldn't run, so the spy below would be untouched.
    const successSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, content: { recovered: true } }),
    });
    global.fetch = successSpy as any;
    const ok = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
    expect(ok).toEqual({ recovered: true });
    expect(successSpy).toHaveBeenCalledTimes(1); // bridge attempted, not skipped
  });

  it('still treats 500 as a real failure (circuit opens after 5)', async () => {
    setEnvForBridge();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    }) as any;

    // 5 500-responses → circuit opens on the 5th
    for (let i = 0; i < 5; i++) {
      const result = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
      expect(result).toBeNull();
    }

    // 6th call — circuit is open, fetch should NOT be called
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    });
    global.fetch = fetchSpy as any;
    const result = await callClaudeJSONViaBridge({ system: 's', user: 'u' });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
