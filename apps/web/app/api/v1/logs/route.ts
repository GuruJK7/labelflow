import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { NextRequest } from 'next/server';

/**
 * Recursively redact sensitive keys from a JSON-ish object before exposing it
 * via the logs endpoint. RunLog.meta is written by many parts of the system
 * (worker, web API, future debug logs) and we cannot trust callers to never
 * write a secret. This sanitizer is the last line of defense between
 * RunLog.meta and the tenant's browser. Audit 2026-04-27 H-04.
 *
 * Matches keys case-insensitively against a deny-list. The match is on the
 * key name itself, not the value, so it survives JSON serialization quirks.
 */
const SENSITIVE_KEY_PATTERN = /^(password|secret|token|api[_-]?key|cvc|pass|credential|authorization|cookie)$/i;

function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitive(v);
      }
    }
    return out;
  }
  return value;
}

export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');
  const since = searchParams.get('since');
  const limit = parseInt(searchParams.get('limit') ?? '200');

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (jobId) where.jobId = jobId;
  if (since) {
    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      return apiError('Invalid since parameter — must be a valid ISO date', 400);
    }
    where.createdAt = { gt: sinceDate };
  }

  const logs = await db.runLog.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: Math.min(limit, 500),
    select: {
      id: true,
      level: true,
      message: true,
      meta: true,
      createdAt: true,
      jobId: true,
    },
  });

  // Also return the active/latest job
  const activeJob = await db.job.findFirst({
    where: { tenantId: auth.tenantId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      trigger: true,
      totalOrders: true,
      successCount: true,
      failedCount: true,
      skippedCount: true,
      durationMs: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });

  // Sanitize meta on the way out — defense in depth against any RunLog row
  // (current or future) that may contain credentials in its meta JSON.
  const sanitizedLogs = logs.map((log) => ({
    ...log,
    meta: redactSensitive(log.meta),
  }));

  return apiSuccess({ logs: sanitizedLogs, activeJob });
}
