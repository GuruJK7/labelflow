import { redirect } from 'next/navigation';
import { getAuthenticatedTenant } from '@/lib/api-utils';
import { db } from '@/lib/db';

/**
 * Server-component layout for /onboarding.
 *
 * Why this layout exists at all:
 *   The onboarding page itself is `'use client'` (form state, step UI),
 *   and middleware runs on the Edge runtime so it can't read the DB.
 *   This layout is the only server-side place where we can enforce the
 *   email-verification gate BEFORE the user is allowed to type their
 *   Shopify token / DAC password into the wizard.
 *
 *   The /(dashboard)/layout.tsx already enforces the same gate; this
 *   keeps the policy consistent across the two server-side surfaces a
 *   freshly-signed-up user can hit while authenticated.
 *
 * Why we don't enforce auth here too: middleware already redirects
 *   unauthenticated traffic — but `/onboarding` is in middleware's
 *   `publicPaths` list (so unauth visitors can preview the page during
 *   the OAuth dance). If somehow an authenticated user with an unverified
 *   email lands here, we bounce them to /verify-email; otherwise we
 *   pass through.
 *
 *   We do NOT redirect when there's no session at all — leaving that to
 *   middleware + the underlying API calls, which 401 on save attempts.
 *
 * Cost: one DB read per onboarding request (already cheap; the same
 *   tenant query also feeds the page's prefilled creds when we add that
 *   later).
 */
export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const verifyRequired =
    process.env.EMAIL_VERIFICATION_REQUIRED === '1' ||
    process.env.EMAIL_VERIFICATION_REQUIRED === 'true';

  // Fast path: gate is off → no DB hit, render through.
  if (!verifyRequired) return <>{children}</>;

  const auth = await getAuthenticatedTenant();
  // No session: middleware will handle / the API will 401 on save.
  // Don't redirect here — onboarding is a public page during the auth
  // bootstrap of some flows.
  if (!auth) return <>{children}</>;

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { email: true, emailVerified: true },
  });

  if (user && !user.emailVerified) {
    redirect(`/verify-email?email=${encodeURIComponent(user.email)}`);
  }

  return <>{children}</>;
}
