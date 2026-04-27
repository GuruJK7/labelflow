import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';

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

  const tokenRow = await db.emailVerificationToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
      user: { select: { id: true, emailVerified: true } },
    },
  });

  if (!tokenRow) return buildRedirect(req, 'invalid');
  if (tokenRow.usedAt) return buildRedirect(req, 'used');
  if (tokenRow.expiresAt.getTime() <= Date.now()) {
    return buildRedirect(req, 'expired');
  }

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

  return buildRedirect(req, 'ok');
}
