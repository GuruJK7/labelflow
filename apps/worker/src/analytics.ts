/**
 * Worker-side PostHog helper for server events that originate in the
 * background worker (not in apps/web). The only user of this today is
 * the `first_shipment_created` event fired the first time a tenant
 * successfully consumes a credit (i.e. their very first label landed).
 *
 * The worker is a long-lived Node process on Render, NOT serverless, so
 * the `flushAt: 1 + await shutdown()` pattern from apps/web isn't
 * needed. Instead we keep a singleton client and let `flushInterval`
 * batch events. On worker SIGTERM we flush before exit (handled in
 * apps/worker/src/index.ts shutdown handler — see TODO note below).
 *
 * `distinctId` MUST be the tenantId (cuid) — same identifier the web
 * client uses via posthog.identify() — so events stitch to the same
 * person profile. Never pass email, addresses, or any PII as distinctId
 * or in properties.
 */

import { PostHog } from 'posthog-node';
import logger from './logger';

let cached: PostHog | null = null;

function getClient(): PostHog | null {
  const key = process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!key || !host) return null;
  if (cached) return cached;
  cached = new PostHog(key, {
    host,
    flushAt: 20,
    flushInterval: 10_000,
  });
  return cached;
}

/**
 * Fire a worker event. Fire-and-forget — analytics failures never block
 * a job from completing. We log at debug level so noisy "PostHog 5xx"
 * runs don't drown the real shipment logs.
 */
export function trackWorker(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({ distinctId, event, properties });
  } catch (err) {
    logger.debug({ err, event }, 'PostHog capture failed (worker)');
  }
}

/**
 * Flush the in-memory queue. Called from the worker's SIGTERM handler so
 * pending events land before the process exits during a Render redeploy.
 */
export async function flushWorkerAnalytics(): Promise<void> {
  if (!cached) return;
  try {
    await cached.shutdown();
  } catch {
    // Don't block shutdown on analytics flush failures.
  } finally {
    cached = null;
  }
}
