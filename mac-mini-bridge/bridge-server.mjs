#!/usr/bin/env node
/**
 * LabelFlow Claude Max bridge — Mac Mini side.
 *
 * Tiny HTTP server that accepts address-correction jobs from the Render
 * worker over Tailscale and forwards them to the locally-installed
 * `claude` CLI (Claude Max subscription). Return a JSON result in the
 * exact same shape the CLI would have written to ADDRESS_RESULT_PATH.
 *
 * Designed to be zero-dependency: only node:* modules. Runs under a
 * LaunchAgent (com.labelflow.claude-bridge.plist) with KeepAlive=true.
 *
 * Auth: shared secret in X-Labelflow-Secret header (constant-time compare).
 * Binding: 0.0.0.0 so Tailscale can reach it. ACLs restrict who connects.
 * Concurrency: one claude spawn at a time (a mutex); extras get 429.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.BRIDGE_PORT || 7777);
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';
const CLAUDE_BIN = process.env.CLAUDE_BIN || `${os.homedir()}/.local/bin/claude`;
const SECRET = process.env.LABELFLOW_BRIDGE_SECRET;
const MAX_BODY = 64 * 1024; // 64 KiB — address JSON is well under 4 KiB
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 90_000);
const TMP_DIR = process.env.BRIDGE_TMP_DIR || '/tmp';

if (!SECRET || SECRET.length < 16) {
  console.error('[bridge] FATAL: LABELFLOW_BRIDGE_SECRET must be set (>=16 chars)');
  process.exit(1);
}

// ─── concurrency guard ──────────────────────────────────────────────────────
let inflight = 0;
const MAX_INFLIGHT = 1;

// ─── env whitelist for spawned claude CLI ───────────────────────────────────
// H-8 (2026-04-21 audit): the bridge runs under a LaunchAgent on the Mac Mini;
// the env inherited there includes LABELFLOW_BRIDGE_SECRET and whatever else
// the operator sets. Before this fix the `claude` child inherited ALL of it
// via `env: { ...process.env }`. If Claude ever shelled out (Read/Write tools
// shouldn't, but defense in depth), the bridge secret would have been visible
// to the child. Whitelist the handful of vars the CLI genuinely needs.
const CLAUDE_ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'ANTHROPIC_API_KEY',
  'CLAUDE_BIN', 'CLAUDE_CONFIG_DIR',
]);
function buildClaudeChildEnv() {
  const out = {};
  for (const k of Object.keys(process.env)) {
    if (CLAUDE_ENV_WHITELIST.has(k)) out[k] = process.env[k];
  }
  return out;
}

// ─── logging ────────────────────────────────────────────────────────────────
function log(level, msg, extra = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  process.stdout.write(line + '\n');
}

// ─── auth ───────────────────────────────────────────────────────────────────
// C-7 (2026-04-21 audit): the previous form did `header.length !== SECRET.length`
// as an early-return, which made the wall-clock difference between "wrong length"
// and "wrong value" observable and leaked the secret's length to attackers.
// The padded constant-time compare below does the same byte-level work for any
// input up to MAX_SECRET_HEADER_LEN, then folds the length-equality check into
// the final boolean AFTER the expensive compare has already run.
const MAX_SECRET_HEADER_LEN = Math.max(SECRET.length, 128);
const SECRET_PADDED = Buffer.alloc(MAX_SECRET_HEADER_LEN);
Buffer.from(SECRET, 'utf8').copy(SECRET_PADDED);

function checkAuth(req) {
  const header = req.headers['x-labelflow-secret'];
  const provided = typeof header === 'string' ? header : '';
  const providedBuf = Buffer.alloc(MAX_SECRET_HEADER_LEN);
  // Buffer.from() will refuse to write past the destination end — slice first
  // so we never throw, just truncate over-long inputs (and the compare fails).
  Buffer.from(provided, 'utf8').copy(providedBuf, 0, 0, MAX_SECRET_HEADER_LEN);
  let bytesEqual = false;
  try {
    bytesEqual = timingSafeEqual(providedBuf, SECRET_PADDED);
  } catch {
    // Shouldn't happen (equal-length buffers) — belt and suspenders.
    bytesEqual = false;
  }
  // Length equality is only consulted AFTER the constant-time compare so it
  // can't short-circuit the timing.
  return bytesEqual && provided.length === SECRET.length;
}

// ─── body parsing with size cap ─────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── the claude spawn ───────────────────────────────────────────────────────
async function runClaudeCorrection(context) {
  const runId = randomUUID();
  const ctxPath = path.join(TMP_DIR, `labelflow-bridge-ctx-${runId}.json`);
  const resPath = path.join(TMP_DIR, `labelflow-bridge-res-${runId}.json`);

  const tmp = ctxPath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(context, null, 2), { mode: 0o600 });
  await fs.rename(tmp, ctxPath);

  const reasons = (context.classificationReasons || []).join(', ');
  const prompt =
    `Read ${ctxPath}. You are correcting a Shopify shipping address for Uruguay courier DAC.\n` +
    `The order was classified YELLOW due to: ${reasons}.\n` +
    `Resolve: (1) map city to the correct DAC department from validDepartments, ` +
    `(2) strip apartment/floor markers from address1 and put them in notes, ` +
    `(3) normalize phone to 8 digits only (use "00000000" if clearly invalid).\n` +
    `Write the result to ${resPath} as JSON:\n` +
    `  Success: {"success":true,"override":{"address1":"...","notes":"...","department":"...","city":"...","phone":"..."},"reasoning":"..."}\n` +
    `  Failure: {"success":false,"reasoning":"cannot resolve — <reason>"}\n` +
    `Only include fields in override that actually need correcting. Exit after writing the file.`;

  try {
    const result = await new Promise((resolve) => {
      const child = spawn(CLAUDE_BIN, [
        '-p',
        '--model', 'haiku',
        '--allowed-tools', 'Read,Write',
        '--output-format', 'json',
        prompt,
      ], { stdio: ['ignore', 'pipe', 'pipe'], env: buildClaudeChildEnv() });

      let stderr = '';
      let stdout = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      }, CLAUDE_TIMEOUT_MS);

      child.stdout?.on('data', (c) => { stdout += c.toString(); });
      child.stderr?.on('data', (c) => { stderr += c.toString(); });

      child.on('close', async (code) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({ success: false, error: 'timeout', reasoning: `Spawn exceeded ${CLAUDE_TIMEOUT_MS}ms` });
          return;
        }

        try {
          const raw = await fs.readFile(resPath, 'utf8');
          resolve(JSON.parse(raw));
        } catch (err) {
          resolve({
            success: false,
            error: `claude exited ${code ?? 'null'} without writing result`,
            reasoning: (stderr || stdout).slice(0, 500) || 'no output',
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: `spawn failed: ${err.message}`, reasoning: '' });
      });
    });

    return result;
  } finally {
    await fs.unlink(ctxPath).catch(() => {});
    await fs.unlink(resPath).catch(() => {});
  }
}

// ─── routes ─────────────────────────────────────────────────────────────────
async function handle(req, res) {
  // Health check — unauthenticated, for LaunchAgent / Tailscale probe
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, inflight, maxInflight: MAX_INFLIGHT }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/correct-address') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  if (!checkAuth(req)) {
    log('warn', 'auth-fail', { ip: req.socket.remoteAddress });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  // M-3 (2026-04-21 audit): atomic check-and-increment of the inflight
  // counter. The previous layout did the check, THEN awaited body parsing,
  // THEN incremented — so two concurrent requests could both read inflight=0,
  // both pass, both await, and both eventually increment to 2 (violating
  // MAX_INFLIGHT=1 and spawning two `claude` subprocesses). Node's HTTP
  // handler is single-threaded but NOT atomic across `await` boundaries.
  //
  // Every branch below inflight++ must reach the matching finally that does
  // inflight-- — the try/finally wraps ALL of body parsing, JSON parsing,
  // validation, and the claude run.
  if (inflight >= MAX_INFLIGHT) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
    res.end(JSON.stringify({ error: 'busy', inflight }));
    return;
  }
  inflight++;
  const t0 = Date.now();

  try {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    let context;
    try {
      context = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    if (!context || typeof context !== 'object' || !context.shipping_address) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing shipping_address' }));
      return;
    }

    log('info', 'claude-start', { jobId: context.jobId, orderId: context.orderId });

    try {
      const result = await runClaudeCorrection(context);
      const ms = Date.now() - t0;
      log('info', 'claude-done', {
        jobId: context.jobId,
        orderId: context.orderId,
        success: !!result.success,
        ms,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      log('error', 'claude-error', { err: String(err?.message || err) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: String(err?.message || err) }));
    }
  } finally {
    inflight--;
  }
}

// ─── server ─────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log('error', 'unhandled', { err: String(err?.message || err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  });
});

server.listen(PORT, HOST, () => {
  log('info', 'listening', { host: HOST, port: PORT, claudeBin: CLAUDE_BIN });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('info', 'shutdown', { sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
