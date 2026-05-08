import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { cookies, headers } from 'next/headers';
import { db } from './db';
import {
  generateReferralCode,
  isValidReferralCodeShape,
  readReferralCookieValue,
  REFERRAL_COOKIE_NAME,
} from './referrals';
import { trackServer } from './analytics.server';

const REFEREE_BONUS_CREDITS = 10;

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        try {
          if (!credentials?.email || !credentials?.password) return null;

          const user = await db.user.findUnique({
            where: { email: credentials.email.toLowerCase() },
          });

          if (!user || !user.passwordHash) return null;

          const valid = await bcrypt.compare(credentials.password, user.passwordHash);
          if (!valid) return null;

          return { id: user.id, email: user.email, name: user.name };
        } catch {
          return null;
        }
      },
    }),
    ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
          }),
        ]
      : []),
  ],
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 }, // 7 days instead of 30
  cookies: {
    sessionToken: {
      name: process.env.NODE_ENV === 'production'
        ? '__Secure-next-auth.session-token'
        : 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        domain: process.env.NODE_ENV === 'production' ? '.autoenvia.com' : undefined,
      },
    },
  },
  pages: {
    signIn: '/login',
    newUser: '/onboarding',
  },
  callbacks: {
    async jwt({ token, user, trigger, session: updateSession }) {
      if (user) {
        token.id = user.id;
      }

      // ── Multi-store tenant switch ──
      // The /api/tenants/switch endpoint calls update({ tenantId }) on the
      // client, which fires a 'update' trigger here with the new tenantId
      // in updateSession. We re-validate ownership and refresh the token
      // with the chosen tenant's data.
      if (trigger === 'update' && updateSession && typeof updateSession === 'object') {
        const requestedTenantId = (updateSession as Record<string, unknown>).tenantId;
        if (typeof requestedTenantId === 'string' && token.id) {
          const owned = await db.tenant.findFirst({
            where: { id: requestedTenantId, userId: token.id as string },
            select: { id: true, slug: true },
          });
          if (owned) {
            // Audit 2026-05-08 — multi-store credit pool. tenantId/slug
            // come from the requested store (the user is choosing which
            // store to be active in), but isActive/subscriptionStatus
            // come from the user's CREDIT-HOLDER tenant (oldest one).
            // All of the user's stores share the holder's billing state.
            const holder = await db.tenant.findFirst({
              where: { userId: token.id as string },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { isActive: true, subscriptionStatus: true },
            });
            token.tenantId = owned.id;
            token.tenantSlug = owned.slug;
            token.isActive = holder?.isActive ?? false;
            token.subscriptionStatus = holder?.subscriptionStatus ?? 'INACTIVE';
            token.tenantRefreshedAt = Math.floor(Date.now() / 1000);
            return token;
          }
          // If the user doesn't own the requested tenantId, we silently
          // ignore the switch (defense against a tampered client). Token
          // keeps its previous tenantId.
        }
      }

      // Query DB on first mint (no tenantId) AND every 15 minutes thereafter
      // so that subscription changes (upgrade, cancellation, plan expiry) are
      // reflected in the JWT within a bounded window. Without the time check
      // the token only refreshed once — on first sign-in — and carried stale
      // subscriptionStatus for up to 7 days (the JWT maxAge).
      const REFRESH_INTERVAL_S = 15 * 60; // 15 minutes
      const now = Math.floor(Date.now() / 1000);
      const needsRefresh =
        !token.tenantId ||
        !token.tenantRefreshedAt ||
        now - (token.tenantRefreshedAt as number) > REFRESH_INTERVAL_S;

      if (token.id && needsRefresh) {
        // Multi-store aware lookup:
        //   1. If the token already has a tenantId (carried across refresh
        //      cycles), re-load THAT specific tenant — preserves the user's
        //      current store selection across the 15-min refresh window.
        //   2. If the token has no tenantId yet (first session after login),
        //      pick the first tenant the user owns ordered by createdAt.
        //      This is the deterministic default for multi-store accounts:
        //      "the store you originally onboarded with".
        // Audit 2026-05-08 — multi-store credit pool. tenantId/slug
        // come from whichever store the user picked (or the holder on
        // first mint). isActive/subscriptionStatus ALWAYS come from
        // the user's CREDIT-HOLDER tenant (oldest one) so the JWT
        // billing flags reflect the user's account state, not the
        // selected store's local flags.
        const [activeStore, holder] = await Promise.all([
          token.tenantId
            ? db.tenant.findFirst({
                where: { id: token.tenantId as string, userId: token.id as string },
                select: { id: true, slug: true },
              })
            : db.tenant.findFirst({
                where: { userId: token.id as string },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true, slug: true },
              }),
          db.tenant.findFirst({
            where: { userId: token.id as string },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { isActive: true, subscriptionStatus: true },
          }),
        ]);
        const tenant = activeStore && holder
          ? {
              id: activeStore.id,
              slug: activeStore.slug,
              isActive: holder.isActive,
              subscriptionStatus: holder.subscriptionStatus,
            }
          : null;
        // Audit 2026-05-08 — refresh-stamp logic rewritten.
        //
        // OLD behavior: stamped `tenantRefreshedAt = now` UNCONDITIONALLY,
        // even when the tenant lookup returned null. The intent was to
        // protect the DB from per-request retries when a user has no
        // tenant (interrupted OAuth, etc.).
        //
        // BUG: when the tenant query failed for a transient reason
        // (Supabase incident, pgbouncer prepared-statement glitch, race
        // with very recent signup), the user's JWT got "lobotomized":
        // it had `id` set but `tenantId` undefined, AND `tenantRefreshedAt`
        // freshly stamped → no further retries for 15 minutes →
        // `getAuthenticatedTenant()` returns null on every API call →
        // user sees "No autorizado" on every protected endpoint until
        // they manually log out and back in.
        //
        // FIX: stamp the refresh time differently for each outcome:
        //   - tenant FOUND        → stamp now (full 15-min cooldown)
        //   - tenant MISSING but
        //     token had tenantId  → tenant was deleted/transferred away;
        //                           clear and stamp now (no retry needed)
        //   - tenant MISSING and
        //     token had none      → potential transient issue or new
        //                           signup race. Use a SHORT cooldown
        //                           (60s) so the next request tries again
        //                           soon — but don't hammer the DB.
        if (tenant) {
          token.tenantId = tenant.id;
          token.tenantSlug = tenant.slug;
          token.isActive = tenant.isActive;
          token.subscriptionStatus = tenant.subscriptionStatus;
          token.tenantRefreshedAt = now;
        } else if (token.tenantId) {
          // The previously-selected tenant no longer exists or no longer
          // belongs to this user (e.g. they deleted the store, or admin
          // moved it). Clear the stale reference so the next refresh falls
          // back to "first tenant" path above.
          delete token.tenantId;
          delete token.tenantSlug;
          token.tenantRefreshedAt = now;
        } else {
          // No tenant found and no prior tenantId in the token. The
          // most likely causes are (a) very recent signup where the
          // tenant row's transaction wasn't visible to this connection
          // yet, (b) a transient DB error, or (c) genuinely a user
          // without any tenant (rare — interrupted OAuth flow). For
          // (a) and (b) we want to retry soon; for (c) the cost of an
          // occasional retry is negligible. Back-date by
          // (REFRESH_INTERVAL_S - 60) so the next request triggers a
          // fresh refresh in ~60 seconds.
          token.tenantRefreshedAt = now - REFRESH_INTERVAL_S + 60;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as Record<string, unknown>).id = token.id;
        (session.user as Record<string, unknown>).tenantId = token.tenantId;
        (session.user as Record<string, unknown>).tenantSlug = token.tenantSlug;
        (session.user as Record<string, unknown>).isActive = token.isActive;
        (session.user as Record<string, unknown>).subscriptionStatus = token.subscriptionStatus;
      }
      return session;
    },
    async signIn({ user, account }) {
      if (account?.provider !== 'google' || !user.email) return true;

      const email = user.email.toLowerCase();
      // Multi-store schema (2026-05-01): User.tenant (1:1) → User.tenants (1:N).
      // For "is this a returning user?" we just need to know if they have
      // ANY tenant; the JWT callback handles which one becomes active. So
      // we only fetch the count + the user id — no need for the full row.
      const existing = await db.user.findUnique({
        where: { email },
        select: {
          id: true,
          _count: { select: { tenants: true } },
        },
      });

      // Existing user logging in via Google again — nothing to provision.
      // The 10-shipment welcome bonus was already granted at first signup
      // via the schema `@default(10)`, so a re-login MUST NOT touch it.
      if (existing && existing._count.tenants > 0) return true;

      // ── First-time Google OAuth signup ──
      // Mirror /api/auth/signup so OAuth users get the same referral
      // attribution + signed-cookie validation as email/password signups.
      // Reading cookies inside a NextAuth signIn callback works because
      // NextAuth runs the callback inside the OAuth callback route handler,
      // which keeps the request context (cookies, headers) attached.
      let referredByCode: string | null = null;
      let referredById: string | null = null;
      try {
        const cookieStore = cookies();
        const refCookie = cookieStore.get(REFERRAL_COOKIE_NAME)?.value ?? null;
        const referralCode = readReferralCookieValue(refCookie);
        if (referralCode && isValidReferralCodeShape(referralCode)) {
          const referrer = await db.tenant.findUnique({
            where: { referralCode },
            select: { id: true, user: { select: { email: true } } },
          });
          // Anti-self-referral by email (best-effort — same as signup route).
          if (referrer && referrer.user?.email?.toLowerCase() !== email) {
            referredByCode = referralCode;
            referredById = referrer.id;
          }
        }
      } catch {
        // cookies() throws if called outside a request scope — extremely
        // unlikely here but we'd rather lose attribution than block signup.
      }

      // Build base slug from email + millis to avoid collisions across
      // accounts that share a local-part (e.g. john@gmail / john@outlook).
      const baseSlug =
        email.split('@')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase() +
        '-' +
        Date.now().toString(36);

      // Generate a unique referral code with retries on collision (same
      // shape as signup/route.ts — keeps both paths interchangeable).
      let myReferralCode: string | null = null;
      for (let attempt = 0; attempt < 5 && !myReferralCode; attempt++) {
        const candidate = generateReferralCode(baseSlug);
        const collision = await db.tenant.findUnique({
          where: { referralCode: candidate },
          select: { id: true },
        });
        if (!collision) myReferralCode = candidate;
      }

      const refereeBonus = referredById ? REFEREE_BONUS_CREDITS : 0;

      // Capture IP for Ley 18.331 compliance (same as email/password signup).
      let signupIp = 'unknown';
      try {
        const h = headers();
        signupIp =
          h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
          h.get('x-real-ip') ||
          'unknown';
      } catch {
        // headers() throws outside request scope — keep 'unknown'.
      }

      let newTenantId: string | null = null;

      if (existing) {
        // Edge case: User row exists (from a previous orphaned attempt
        // where Tenant creation failed) but no Tenant. Backfill the Tenant
        // without touching the User.
        const t = await db.tenant.create({
          data: {
            userId: existing.id,
            name: user.name ?? baseSlug,
            slug: baseSlug,
            apiKey: crypto.randomBytes(32).toString('hex'),
            signupIp,
            tosAcceptedAt: new Date(),
            referralCode: myReferralCode,
            referredByCode,
            referredById,
            referralBonusCredits: refereeBonus,
          },
        });
        newTenantId = t.id;
      } else {
        // Atomic User + Tenant creation via Prisma nested write.
        // shipmentCredits arranca en 10 por @default del schema (welcome
        // bonus universal). referralBonusCredits SÓLO si vino vía referral.
        //
        // Multi-store note: `tenants: { create: [...] }` produces the
        // same effect as the old 1:1 `tenant: { create: ... }` — creates
        // exactly one Tenant during signup. Additional stores are added
        // later via POST /api/v1/tenants.
        const created = await db.user.create({
          data: {
            email,
            name: user.name,
            image: user.image,
            emailVerified: new Date(),
            tenants: {
              create: [
                {
                  name: user.name ?? baseSlug,
                  slug: baseSlug,
                  apiKey: crypto.randomBytes(32).toString('hex'),
                  signupIp,
                  tosAcceptedAt: new Date(),
                  referralCode: myReferralCode,
                  referredByCode,
                  referredById,
                  referralBonusCredits: refereeBonus,
                },
              ],
            },
          },
          include: {
            tenants: {
              select: { id: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        });
        newTenantId = created.tenants[0]?.id ?? null;
      }

      // Fire #4 signup_completed for the OAuth path (mirror of the same
      // event fired from /api/auth/signup for email/password). distinct_id
      // is the tenantId so client + server events stitch into the same
      // PostHog person profile when IdentifyOnAuth runs after redirect.
      // No PII in properties (method enum + boolean only).
      if (newTenantId) {
        await trackServer(newTenantId, 'signup_completed', {
          method: 'google',
          has_referral: Boolean(referredById),
        });
      }

      return true;
    },
  },
};

export function requireTenantId(session: Record<string, unknown>): string {
  const tenantId = (session.user as Record<string, unknown>)?.tenantId as string | undefined;
  if (!tenantId) {
    throw new Error('NO_TENANT');
  }
  return tenantId;
}
