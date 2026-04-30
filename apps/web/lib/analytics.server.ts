/**
 * Server-side analytics helper for events that MUST not be lost to a
 * client closing the tab (signup_completed, email_verified,
 * subscription_activated). Uses posthog-node, NOT posthog-js.
 *
 * Vercel serverless gotcha: the function shuts down right after the
 * request handler returns. If we don't `await ph.shutdown()` (or
 * `flushAsync()`), buffered events get dropped. We choose `flushAt: 1` so
 * each capture flushes immediately, then await `shutdown()` after the
 * single capture — this is the simplest correct pattern for serverless.
 *
 * `distinctId` MUST be the tenantId (cuid) — same identifier the client
 * uses via posthog.identify() — so client + server events stitch into
 * the same person profile. NEVER pass email, name, or any PII as
 * distinctId or in properties.
 */

import { PostHog } from 'posthog-node';

let cached: PostHog | null = null;

function getClient(): PostHog | null {
  // Server uses the same project key. If you want a separate key for
  // server-side, switch this to POSTHOG_KEY (without NEXT_PUBLIC_) and
  // set both env vars on Vercel.
  const key = process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!key || !host) return null;
  if (cached) return cached;
  cached = new PostHog(key, {
    host,
    flushAt: 1,
    flushInterval: 0,
  });
  return cached;
}

/**
 * Fire a single server-side event and immediately flush. Safe to call
 * fire-and-forget from inside a route handler — we await shutdown to
 * ensure the event lands before the serverless function freezes.
 *
 * Errors are swallowed: analytics MUST NEVER take down a real flow
 * (signup, payment, label creation). If PostHog is down, the user still
 * completes their action.
 */
export async function trackServer(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({ distinctId, event, properties });
    await ph.shutdown();
    cached = null;
  } catch {
    // Intentionally silent — see fn comment.
  }
}
