/**
 * GET /api/health
 *
 * Lightweight uptime + dependency probe (2026-05-15). Hits the three
 * things that ARE LabelFlow's actual point of failure:
 *   1. Postgres (Supabase) — `SELECT 1` round-trip
 *   2. Redis (rate-limiter / cache) — PING, treated as optional
 *   3. Mac Mini bridge — GET /health (set via LABELFLOW_BRIDGE_URL)
 *
 * Each check has its own short timeout so a single slow dependency
 * doesn't make `/api/health` itself slow. A failed bridge does NOT mark
 * the service unhealthy overall — the worker has its own circuit breaker
 * + API fallback. Only Postgres being down returns HTTP 503; everything
 * else is reported as "degraded" but still 200.
 *
 * Public endpoint — no auth. Designed for:
 *   - Render's built-in health-check (looks for HTTP 200)
 *   - Better Uptime / Pingdom / UptimeRobot
 *   - Operator's eyeball check when something feels off
 *
 * NEVER include secrets, env names, or internal hostnames in the response.
 * If the bridge is misconfigured we say "unreachable" — not the URL.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getRedis } from '@/lib/redis';

export const runtime = 'nodejs';

// Force the route to bypass any caching at the Next.js layer. Health checks
// must reflect REAL state of dependencies, not a memoized snapshot.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DB_TIMEOUT_MS = 2_000;
const REDIS_TIMEOUT_MS = 1_000;
const BRIDGE_TIMEOUT_MS = 3_000;

type CheckResult =
  | { status: 'ok'; ms: number }
  | { status: 'degraded'; ms: number; reason: string }
  | { status: 'fail'; ms: number; reason: string }
  | { status: 'not_configured' };

/** Race a Promise against a timeout. Uses a fresh AbortController for fetch
 *  cases, plus a simple Promise.race for non-fetch ones. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}-timeout`)), ms),
    ),
  ]);
}

async function checkDb(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, DB_TIMEOUT_MS, 'db');
    return { status: 'ok', ms: Date.now() - t0 };
  } catch (err) {
    return {
      status: 'fail',
      ms: Date.now() - t0,
      reason: (err as Error).message.slice(0, 100),
    };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const redis = getRedis();
  if (!redis) return { status: 'not_configured' };
  const t0 = Date.now();
  try {
    await withTimeout(redis.ping(), REDIS_TIMEOUT_MS, 'redis');
    return { status: 'ok', ms: Date.now() - t0 };
  } catch (err) {
    return {
      status: 'degraded',
      ms: Date.now() - t0,
      reason: (err as Error).message.slice(0, 100),
    };
  }
}

async function checkBridge(): Promise<CheckResult> {
  const url = process.env.LABELFLOW_BRIDGE_URL;
  if (!url) return { status: 'not_configured' };
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: controller.signal,
      // No auth header on /health — the bridge has it open for exactly
      // this kind of probe (see bridge-server.mjs:330).
    });
    if (!res.ok) {
      return {
        status: 'degraded',
        ms: Date.now() - t0,
        reason: `http-${res.status}`,
      };
    }
    return { status: 'ok', ms: Date.now() - t0 };
  } catch (err) {
    return {
      status: 'degraded',
      ms: Date.now() - t0,
      reason: (err as Error).name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const startedAt = Date.now();

  // Fire all checks in parallel — each has its own timeout, so the slowest
  // dependency caps the response time at max(DB, REDIS, BRIDGE) ≈ 3 s.
  const [dbResult, redisResult, bridgeResult] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkBridge(),
  ]);

  // DB is the only HARD dependency. If Redis is down we fall open on rate
  // limits; if the bridge is down the worker uses the API. Without the
  // DB, NOTHING works — so that's the only check that flips overall to 503.
  const overall: 'ok' | 'degraded' | 'fail' =
    dbResult.status === 'fail'
      ? 'fail'
      : redisResult.status === 'degraded' || bridgeResult.status === 'degraded'
        ? 'degraded'
        : 'ok';

  const httpStatus = overall === 'fail' ? 503 : 200;

  return NextResponse.json(
    {
      status: overall,
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? 'unknown',
      checks: {
        db: dbResult,
        redis: redisResult,
        bridge: bridgeResult,
      },
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    },
    { status: httpStatus },
  );
}
