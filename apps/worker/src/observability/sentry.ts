/**
 * Sentry instrumentation for the LabelFlow worker (2026-05-15).
 *
 * Initializes Sentry SDK at startup IF `SENTRY_DSN` env var is set.
 * When unset (preview deploys, local dev), every Sentry call is a no-op —
 * no errors, no overhead, no behavior change. This makes Sentry opt-in
 * via env var only, exactly the same posture as the bridge.
 *
 * Why an indirection layer (this file) instead of `import * as Sentry`
 * everywhere:
 *   1. Single place to configure DSN, environment, tracesSampleRate.
 *   2. `captureException` becomes a callable that doesn't care whether
 *      Sentry is initialized — call sites stay clean.
 *   3. If we ever swap Sentry for a different APM (Datadog, Honeycomb),
 *      one file changes.
 *
 * SECURITY:
 *   - We deliberately DROP `event.request.headers` for headers that may
 *     contain secrets (`x-labelflow-secret`, `authorization`, `cookie`).
 *     Sentry's default scrubbing catches `Authorization` but not custom
 *     header names — better to belt-and-suspender it here.
 *   - Customer PII (recipient names, addresses, phones) is NOT
 *     fingerprinted by Sentry; the worker logs them via pino but those
 *     don't flow to Sentry as events.
 */
import * as Sentry from '@sentry/node';
import logger from '../logger';

let initialized = false;

/**
 * Initialize Sentry. Idempotent — safe to call multiple times.
 * Returns true if Sentry is now reporting, false if DSN missing.
 */
export function initSentry(): boolean {
  if (initialized) return Sentry.isInitialized?.() ?? true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('Sentry: SENTRY_DSN not set — observability is local-logs-only');
    initialized = true; // mark as initialized to skip re-checks
    return false;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'unknown',
    // Sample 10% of routine transactions to keep cost low. Errors are
    // always captured regardless of sample rate.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
    // Defense in depth — strip headers that may carry secrets even though
    // Sentry's default beforeSend already redacts well-known ones.
    beforeSend(event) {
      if (event.request?.headers) {
        const sensitive = [
          'authorization',
          'cookie',
          'x-labelflow-secret',
          'x-api-key',
        ];
        for (const key of Object.keys(event.request.headers)) {
          if (sensitive.includes(key.toLowerCase())) {
            (event.request.headers as Record<string, string>)[key] = '[REDACTED]';
          }
        }
      }
      return event;
    },
  });

  initialized = true;
  logger.info(
    {
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      release: process.env.RENDER_GIT_COMMIT?.slice(0, 7),
    },
    'Sentry initialized — errors will be reported',
  );
  return true;
}

/**
 * Report an error to Sentry. Safe no-op when DSN unset.
 * Adds structured `extra` data to the event for context.
 */
export function captureWorkerError(
  err: unknown,
  context?: {
    tenantId?: string;
    jobId?: string;
    orderName?: string;
    step?: string;
    extra?: Record<string, unknown>;
  },
): void {
  if (!initialized || !Sentry.isInitialized?.()) return;
  Sentry.withScope((scope) => {
    if (context?.tenantId) scope.setTag('tenantId', context.tenantId);
    if (context?.jobId) scope.setTag('jobId', context.jobId);
    if (context?.orderName) scope.setTag('orderName', context.orderName);
    if (context?.step) scope.setTag('step', context.step);
    if (context?.extra) scope.setExtras(context.extra);
    Sentry.captureException(err);
  });
}

/**
 * Flush pending Sentry events. Call before `process.exit()` to ensure
 * crash reports actually reach Sentry's ingest.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized || !Sentry.isInitialized?.()) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Never block shutdown on Sentry flush.
  }
}
