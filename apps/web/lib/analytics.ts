'use client';

/**
 * Type-safe client-side analytics helper.
 *
 * Single chokepoint for capturing events from React components. The union
 * type of `EventName` is the source of truth for which events the funnel
 * defines — adding an event here AND in apps/web/docs/analytics.md is the
 * full contract. New events SHOULD be added to both, in lock-step.
 *
 * Privacy contract: properties must NEVER include email, phone, RUT,
 * cedula, addresses, tokens, password, or any free-text customer input.
 * Stick to enums (e.g. `step: 'shopify'|'dac'`), counts (`step_number`),
 * timings (`time_on_step_seconds`), and booleans (`has_referral`).
 *
 * Server-side events (signup_completed, email_verified,
 * first_shipment_created, subscription_activated) live in
 * `lib/analytics.server.ts` — DO NOT call them from here.
 */

import posthog from 'posthog-js';

export type EventName =
  // #2 Click on any CTA that leads to /signup
  | 'signup_started'
  // #3 Click on Google or submit email/password form
  | 'signup_method_selected'
  // #7 First view of /onboarding after auth
  | 'onboarding_started'
  // #8 Each step (shopify, dac) saved successfully
  | 'onboarding_step_completed'
  // #9 Validation/save failed at a step
  | 'onboarding_step_failed'
  // #10 Last step done, redirecting to dashboard
  | 'onboarding_completed';

export type EventProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

export function track(event: EventName, properties?: EventProperties): void {
  if (typeof window === 'undefined') return;
  // posthog.__loaded is false if env vars aren't set — silent no-op so
  // the call site can fire optimistically without checking.
  if (!posthog.__loaded) return;
  posthog.capture(event, properties);
}
