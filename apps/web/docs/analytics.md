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

### Dashboard 1 — Funnel Principal (CREATED 2026-04-30)

Already exists in PostHog: project 404673, dashboard ID 1530582, 7-day window.
Steps: `$pageview` → `signup_started` → `signup_completed` → `email_verified` → `onboarding_step_completed` (step=`shopify`) → `onboarding_step_completed` (step=`dac`) → `first_shipment_created`.
Direct link: <https://us.posthog.com/project/404673/dashboard/1530582>

### Dashboards 2 / 3 / 4 — one-click recipes (run when you have ≥7 days of data)

Each recipe below is a single PostHog URL that pre-populates the insight. Open the URL, click **"Save & add to dashboard"**, then either pick an existing dashboard or click **"+ New dashboard"** in the destination dropdown.

#### Dashboard 2 — Conversion to paid (30-day funnel)

Two-step funnel: who actually pays after their first auto-shipment? If this number is low, the product worked but pricing/UX of the pack-purchase flow is the bottleneck.

```text
https://us.posthog.com/project/404673/insights/new?insight=FUNNELS#q=%7B%22kind%22%3A%22InsightVizNode%22%2C%22source%22%3A%7B%22kind%22%3A%22FunnelsQuery%22%2C%22series%22%3A%5B%7B%22kind%22%3A%22EventsNode%22%2C%22event%22%3A%22first_shipment_created%22%2C%22name%22%3A%22First%20auto-shipment%22%7D%2C%7B%22kind%22%3A%22EventsNode%22%2C%22event%22%3A%22subscription_activated%22%2C%22name%22%3A%22First%20paid%20pack%22%7D%5D%2C%22funnelsFilter%22%3A%7B%22funnelVizType%22%3A%22steps%22%2C%22funnelOrderType%22%3A%22ordered%22%7D%2C%22dateRange%22%3A%7B%22date_from%22%3A%22-30d%22%7D%7D%7D
```

#### Dashboard 3 — Source attribution (which channel converts)

Trends grouped by `$initial_utm_source` for the `signup_completed` event. Tells you which UTM source brings signups (Instagram, WhatsApp share, organic, referral, direct).

```text
https://us.posthog.com/project/404673/insights/new?insight=TRENDS#q=%7B%22kind%22%3A%22InsightVizNode%22%2C%22source%22%3A%7B%22kind%22%3A%22TrendsQuery%22%2C%22series%22%3A%5B%7B%22kind%22%3A%22EventsNode%22%2C%22event%22%3A%22signup_completed%22%2C%22math%22%3A%22total%22%7D%5D%2C%22breakdownFilter%22%3A%7B%22breakdown_type%22%3A%22person%22%2C%22breakdown%22%3A%22%24initial_utm_source%22%7D%2C%22dateRange%22%3A%7B%22date_from%22%3A%22-30d%22%7D%2C%22trendsFilter%22%3A%7B%22display%22%3A%22ActionsBarValue%22%7D%7D%7D
```

#### Dashboard 4 — Onboarding friction

Three insights to combine:

**4a — Failure rate by step** (Trends, daily):
```text
https://us.posthog.com/project/404673/insights/new?insight=TRENDS#q=%7B%22kind%22%3A%22InsightVizNode%22%2C%22source%22%3A%7B%22kind%22%3A%22TrendsQuery%22%2C%22series%22%3A%5B%7B%22kind%22%3A%22EventsNode%22%2C%22event%22%3A%22onboarding_step_failed%22%2C%22math%22%3A%22total%22%7D%5D%2C%22breakdownFilter%22%3A%7B%22breakdown_type%22%3A%22event%22%2C%22breakdown%22%3A%22step%22%7D%2C%22dateRange%22%3A%7B%22date_from%22%3A%22-7d%22%7D%2C%22trendsFilter%22%3A%7B%22display%22%3A%22ActionsBar%22%7D%7D%7D
```

**4b — Average time on each step** (Trends, average of `time_on_step_seconds`):
```text
https://us.posthog.com/project/404673/insights/new?insight=TRENDS#q=%7B%22kind%22%3A%22InsightVizNode%22%2C%22source%22%3A%7B%22kind%22%3A%22TrendsQuery%22%2C%22series%22%3A%5B%7B%22kind%22%3A%22EventsNode%22%2C%22event%22%3A%22onboarding_step_completed%22%2C%22math%22%3A%22avg%22%2C%22math_property%22%3A%22time_on_step_seconds%22%7D%5D%2C%22breakdownFilter%22%3A%7B%22breakdown_type%22%3A%22event%22%2C%22breakdown%22%3A%22step%22%7D%2C%22dateRange%22%3A%7B%22date_from%22%3A%22-7d%22%7D%7D%7D
```

**4c — Stuck-and-bailed session recordings.** Manually in PostHog → Session Replay, filter:
- `pathname` contains `/onboarding`
- `duration > 60` seconds
- person did NOT trigger `onboarding_completed`

Each of these recordings is a real user who gave up mid-onboarding. Watching 5–10 of them tells you exactly which step is the bottleneck (Shopify token paste? DAC creds? something else?).

### How to add these to a dashboard

1. Open one of the URLs above.
2. PostHog renders the pre-configured insight. Verify the data looks right.
3. Top-right: click the **"Save & add to dashboard"** button.
4. From the dropdown, pick **"+ New dashboard"** (or an existing one).
5. Name the dashboard (e.g. "2. Conversion to paid").
6. Done — the insight appears in the dashboard.

### Adblocker caveat (verified 2026-04-30)

If you're testing from your own browser and PostHog Live events look empty, check that your browser doesn't have an adblocker / privacy extension blocking `*.posthog.com`. uBlock Origin, AdGuard, Brave Shields, and Privacy Badger ALL block PostHog by default. The fix is either:
- Allowlist `autoenvia.com` in your blocker, or
- Test from incognito with extensions off, or
- Trust the server-side smoke test (we verified `signup_completed` from `/api/auth/signup/route.ts` lands in PostHog Activity within ~5 seconds).

Real users without blockers get tracked normally — adblock penetration in Uruguay is ~15–20%, so plan for that loss in your funnel-rate denominators.
