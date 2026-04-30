# Analytics — PostHog instrumentation

LabelFlow uses **PostHog** for product analytics, session replay, and web analytics. This document is the source of truth for the funnel events, the privacy contract, and how to add or pause tracking.

## Quick reference

- **Provider**: PostHog Cloud US (`https://us.i.posthog.com`)
- **distinct_id**: Tenant cuid (e.g. `cmckv...`). Set client-side by `IdentifyOnAuth` after NextAuth resolves the session, and matched by every server-side event so client + server stitch into the same person profile.
- **Anonymous visitors**: NOT given person profiles (`person_profiles: 'identified_only'`). They generate `$pageview` events under an anon distinct_id, which is reset to the tenantId once they log in.
- **Sensitive surfaces**: `/dashboard`, `/orders`, `/labels`, `/settings/*` — session replay is **explicitly disabled** here via `posthog.stopSessionRecording()` because end-customer data appears (names, addresses, emails of merchants' buyers).

## Funnel events (12)

The 12 events below are the contract. Adding events outside this list creates noise; if you need a new step, update both this doc and `apps/web/lib/analytics.ts` (client) or use `lib/analytics.server.ts` / `apps/worker/src/analytics.ts` (server).

| # | Event | Type | Fires from | Properties |
|---|---|---|---|---|
| 1 | `$pageview` | client | `PostHogPageview` (auto on every route change) | `$current_url` |
| 2 | `signup_started` | client | `<TrackedSignupLink>` on landing CTAs | `cta_location`: `'navbar' \| 'hero' \| 'hero_secondary' \| 'pricing' \| 'referrals' \| 'final_cta'` |
| 3 | `signup_method_selected` | client | `GoogleSignInButton` onClick + `SignupForm` handleSubmit | `method`: `'google' \| 'email'` |
| 4 | `signup_completed` | server | `lib/auth.ts` signIn callback (Google) + `api/auth/signup/route.ts` (email) | `method`, `has_referral` |
| 5 | `email_verification_sent` | server | `api/auth/signup/route.ts` (only if SMTP send succeeded) | — |
| 6 | `email_verified` | server | `api/auth/verify-email/[token]/route.ts` (first verify only) | `time_to_verify_seconds` |
| 7 | `onboarding_started` | client | `app/onboarding/page.tsx` `useEffect` on mount | — |
| 8 | `onboarding_step_completed` | client | `handleShopifyTest` / `handleDacSave` success branch | `step`: `'shopify' \| 'dac'`, `step_number`, `time_on_step_seconds` |
| 9 | `onboarding_step_failed` | client | `handleShopifyTest` / `handleDacSave` error branches | `step`, `step_number`, `error_code` (HTTP status or `'network'`) |
| 10 | `onboarding_completed` | client | `handleFinish` success | `total_time_seconds` |
| 11 | `first_shipment_created` | server (worker) | `apps/worker/src/credits.ts:deductCreditsAndStamp` (only when `labelsTotal === 0` pre-increment) | `shipments_in_first_run` |
| 12 | `subscription_activated` | server | `api/webhooks/mercadopago/route.ts:handleCreditPackPayment` (only on first PAID purchase per tenant) | `plan` (packId), `amount_uyu` |

## Privacy contract (Ley 18.331 UY + GDPR)

**Hard rules, no exceptions:**

1. **Never** include any of these in event properties — not in `track()`, not in `trackServer()`, not in `trackWorker()`:
   - Email, name, phone, RUT, cédula, addresses (including merchants' end-customer addresses).
   - Shopify tokens, Admin API keys, DAC passwords, MercadoPago client secrets.
   - Free-text customer input or order notes.
   - Anything that could be cross-referenced to identify a real person.
2. `distinct_id` = `tenantId` (Tenant.id, a cuid). **Never** call `posthog.identify(email)`.
3. Session replay only on `/signup`, `/login`, `/onboarding/*` (whitelist in `app/providers/PostHogProvider.tsx`). All inputs masked by default (`maskAllInputs: true`).
4. `respect_dnt: true` — visitors with the Do Not Track header are not tracked.
5. The `error_code` property on `onboarding_step_failed` carries HTTP status codes only (`401`, `422`, etc.) or the literal `'network'`. **Never** the response body or error message — it can leak token shape, shop URL, or DAC error text.

## Provider tree (root layout)

```
<SessionProvider>           # NextAuth context
  <PostHogProvider>         # initializes posthog-js with privacy defaults
    <Suspense>
      <PostHogPageview />   # captures $pageview + manages session-replay path gate
    </Suspense>
    <IdentifyOnAuth />      # posthog.identify(tenantId) post-login
    {children}
  </PostHogProvider>
</SessionProvider>
```

Wired in `app/layout.tsx` via `<Providers>` from `app/providers/index.tsx`.

## Adding a new event

1. **Decide if it's client or server.** Client events are best for UX (clicks, scroll, form interactions). Server events are mandatory for anything billing-related or anything that must NEVER be lost to the user closing the tab (signup, payment, label creation).
2. **Add the name to the union type.**
   - Client: `apps/web/lib/analytics.ts` → extend `EventName`.
   - Server (web): `apps/web/lib/analytics.server.ts` uses string events (no enum) — pass the literal name to `trackServer()`.
   - Worker: `apps/worker/src/analytics.ts` same — pass literal to `trackWorker()`.
3. **Add a row to the table above.**
4. **Verify privacy**: walk the property bag and confirm no PII leaks.
5. **Test live**: open PostHog → Activity → `Live events` → trigger the event → confirm it lands within 30 seconds.

## Pausing analytics

If you want to disable PostHog entirely (privacy incident, debug, regional regulation):

- **Production**: remove `NEXT_PUBLIC_POSTHOG_KEY` from Vercel env vars and trigger a redeploy. The provider's init is gated on this — without the key, `posthog.init()` is skipped and every `track()` call becomes a silent no-op.
- **Worker**: same, remove `POSTHOG_KEY` from Render. `getClient()` returns `null` and `trackWorker()` becomes a no-op.
- **Just session replay**: in PostHog UI → Settings → Recordings → toggle off. The provider still tracks events but stops recording sessions across all devices within ~5 minutes.

## Server-side flush discipline

- **`apps/web/lib/analytics.server.ts`** uses `flushAt: 1` + `await ph.shutdown()` after every capture. This is the correct pattern for Vercel serverless (function freezes after the handler returns; un-flushed events are lost).
- **`apps/worker/src/analytics.ts`** uses `flushAt: 20` + `flushInterval: 10s` (long-lived process pattern). On `SIGTERM` / `SIGINT`, `flushWorkerAnalytics()` is called from `apps/worker/src/index.ts` before `process.exit(0)` so the buffer drains during Render redeploys.

## Funnel dashboards (PostHog UI)

After 7 days of data, set up:

1. **Funnel principal** (7-day window): `$pageview` on `/` → `signup_started` → `signup_completed` → `email_verified` → `onboarding_step_completed` (step=`shopify`) → `onboarding_step_completed` (step=`dac`) → `first_shipment_created`.
2. **Conversion to paid** (30-day window): `first_shipment_created` → `subscription_activated`.
3. **Source attribution** (Trends, group by `$initial_utm_source`, event = `signup_completed`).
4. **Onboarding friction** (combined): time-on-step distribution, `onboarding_step_failed` rate by step, plus a session-recording filter `pathname matches /onboarding AND duration > 60s AND NOT onboarding_completed`.
