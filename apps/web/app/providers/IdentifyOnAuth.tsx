'use client';

/**
 * Identifies the current PostHog visitor with the tenantId once NextAuth
 * resolves the session. Sets distinct_id = tenantId (an internal cuid),
 * NEVER email or any other PII — the entire point of this hook.
 *
 * On logout (status flips back to 'unauthenticated') we reset PostHog so
 * the next visitor on this device starts fresh and isn't merged into the
 * previous user's profile (especially relevant on shared devices).
 */

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import posthog from 'posthog-js';

export function IdentifyOnAuth() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!posthog.__loaded) return;

    if (status === 'unauthenticated') {
      // Detach the previous person profile from this browser so the next
      // visitor isn't accidentally identified as the user who just logged
      // out.
      posthog.reset();
      return;
    }

    if (status !== 'authenticated' || !session?.user) return;

    const tenantId = (session.user as Record<string, unknown>).tenantId as
      | string
      | undefined;
    if (!tenantId) return;

    // No PII in properties. PostHog already auto-tracks $created_at,
    // $initial_utm_source, and the rest of the standard person props.
    posthog.identify(tenantId);
  }, [status, session]);

  return null;
}
