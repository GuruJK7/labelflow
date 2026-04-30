'use client';

/**
 * PostHog client-side initialization + manual page-view tracking.
 *
 * Privacy-first defaults (Ley 18.331 UY + GDPR):
 *   - `respect_dnt: true` — visitors with Do Not Track headers are not tracked.
 *   - `person_profiles: 'identified_only'` — anonymous visitors don't get a
 *     person profile until they sign up. Saves PostHog MTU quota and means
 *     anonymous visitors generate no PII surface.
 *   - `capture_pageview: false` — we manage pageviews manually below so the
 *     App Router's client-side navigation doesn't double-fire on hydration.
 *   - Autocapture restricted to `[data-ph-capture]` selector. Random clicks
 *     are NOT recorded; we only capture what we explicitly opt into.
 *   - Session recording is OFF by default; turned ON only on conversion
 *     surfaces (`/signup`, `/login`, `/onboarding/*`). All inputs masked
 *     (`maskAllInputs: true`) so no token / password / email leaks.
 *
 * Idempotency: `posthog.__loaded` guards against double-init on React
 * StrictMode dev re-mounts and Next.js fast-refresh.
 *
 * Graceful degradation: if `NEXT_PUBLIC_POSTHOG_KEY` is unset (e.g. on
 * preview deploys or until the operator finishes Vercel env-var setup) we
 * skip init entirely. The `track()` helper checks `posthog.__loaded` before
 * firing, so calls are silent no-ops when not configured.
 */

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';

// Conversion-funnel surfaces only. Anything outside this list never gets
// session-recorded — including the dashboard, orders, settings, etc.,
// which contain end-customer PII (names/addresses) that we have no DPA
// to record.
const SESSION_REPLAY_PATHS = ['/signup', '/login', '/onboarding'];

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    if (!key || !host) return;
    if (typeof window === 'undefined') return;
    // Avoid double-init on StrictMode / fast-refresh.
    if (posthog.__loaded) return;

    posthog.init(key, {
      api_host: host,
      person_profiles: 'identified_only',
      capture_pageview: false,
      capture_pageleave: true,
      respect_dnt: true,
      autocapture: {
        dom_event_allowlist: ['click', 'submit', 'change'],
        // ONLY elements with data-ph-capture trigger autocapture. No random
        // clicks anywhere. Keeps the event stream clean and respects
        // privacy-by-default.
        css_selector_allowlist: ['[data-ph-capture]'],
      },
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '[data-ph-mask]',
        recordCrossOriginIframes: false,
      },
      // Disable session recording by default; PostHogPageview re-enables
      // only on the conversion paths.
      disable_session_recording: true,
      loaded: (ph) => {
        if (process.env.NODE_ENV === 'development') ph.debug();
      },
    });
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}

/**
 * Manual pageview tracker + session-replay path gate. Mounted inside
 * <Suspense> in the root layout because `useSearchParams` requires it
 * under App Router.
 */
export function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    if (typeof window === 'undefined') return;
    if (!posthog.__loaded) return;

    const qs = searchParams?.toString();
    const url = window.location.origin + pathname + (qs ? `?${qs}` : '');
    posthog.capture('$pageview', { $current_url: url });

    // Session replay gate: only record on conversion surfaces.
    const shouldRecord = SESSION_REPLAY_PATHS.some((p) => pathname.startsWith(p));
    if (shouldRecord) {
      posthog.startSessionRecording();
    } else {
      posthog.stopSessionRecording();
    }
  }, [pathname, searchParams]);

  return null;
}
