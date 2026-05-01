import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { trackServer } from '@/lib/analytics.server';

/**
 * GET /api/auth/verify-email/[token]
 *
 * Confirms a verification link from the user's inbox. The user clicks the
 * link, we look up the SHA-256 of the path token, validate freshness +
 * single-use, stamp `User.emailVerified`, and redirect to a friendly
 * outcome page (`/verify-email?status=…`).
 *
 * We deliberately use a redirect rather than rendering JSON: the link is
 * opened directly from a mail client and the user expects a page, not an
 * API response. The status surface is a query param so the same client
 * page (`/verify-email`) renders both "send first" and "post-verify"
 * states.
 *
 * Lifecycle invariants enforced:
 *   - Tokens are single-use: `usedAt` IS NULL at lookup time.
 *   - Tokens expire after 24 h (`expiresAt > now`).
 *   - On success we set `User.emailVerified = now` AND stamp `usedAt` in
 *     the same transaction so a successful verify is auditable.
 *   - We never log the plaintext token. The path param is the secret; the
 *     hash is what's persisted.
 */

export const runtime = 'nodejs';

function buildRedirect(req: Request, status: 'ok' | 'expired' | 'invalid' | 'used'): NextResponse {
  // Build redirect target from the request itself (handles preview domains).
  const url = new URL('/verify-email', req.url);
  url.searchParams.set('status', status);
  return NextResponse.redirect(url, { status: 303 });
}

export async function GET(
  req: Request,
  { params }: { params: { token: string } }
) {
  const plaintext = params.token;

  // Sanity check on shape — base64url chars only, 43 chars for 32-byte
  // tokens. Lets us short-circuit obviously-bogus URLs without a DB hit.
  if (!plaintext || !/^[A-Za-z0-9_-]{20,128}$/.test(plaintext)) {
    return buildRedirect(req, 'invalid');
  }

  const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');

  // Multi-store schema (2026-05-01): User.tenant (1:1) became User.tenants
  // (1:N). For email_verified analytics we want a stable distinct_id, so
  // we use the user's FIRST tenant (the one created at signup, ordered by
  // createdAt asc) — exactly the same identity the JWT default-resolves
  // to on first session mint.
  const tokenRow = await db.emailVerificationToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
      user: {
        select: {
          id: true,
          emailVerified: true,
          createdAt: true,
          tenants: {
            select: { id: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      },
    },
  });

  if (!tokenRow) return buildRedirect(req, 'invalid');
  if (tokenRow.usedAt) return buildRedirect(req, 'used');
  if (tokenRow.expiresAt.getTime() <= Date.now()) {
    return buildRedirect(req, 'expired');
  }

  // Capture "was this the first verification?" BEFORE the update so we
  // only fire #6 once per user. If they re-click the link the next day,
  // the prior `emailVerified` is non-null and we skip the event.
  const isFirstVerification = !tokenRow.user?.emailVerified;
  const firstTenantId = tokenRow.user?.tenants?.[0]?.id;

  // Stamp both rows atomically. If the user is already verified (e.g.
  // they clicked the link twice and we lost the race), we still mark the
  // token as used and redirect to the success page — idempotent.
  const now = new Date();
  await db.$transaction([
    db.emailVerificationToken.update({
      where: { id: tokenRow.id },
      data: { usedAt: now },
    }),
    db.user.update({
      where: { id: tokenRow.userId },
      data: { emailVerified: tokenRow.user?.emailVerified ?? now },
    }),
  ]);

  // Fire #6 email_verified — only on first verification, only if we have
  // a tenantId to use as distinct_id. `time_to_verify_seconds` lets us
  // see how long users sit in their inbox; long delays correlate with
  // spam-folder hits and can drive a "resend" UX nudge.
  if (isFirstVerification && firstTenantId && tokenRow.user) {
    const createdAt = tokenRow.user.createdAt.getTime();
    const seconds = Math.round((now.getTime() - createdAt) / 1000);
    await trackServer(firstTenantId, 'email_verified', {
      time_to_verify_seconds: seconds,
    });
  }

  return buildRedirect(req, 'ok');
}
