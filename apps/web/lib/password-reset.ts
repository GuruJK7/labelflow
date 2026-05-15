/**
 * Server-side helpers for the password-reset flow (2026-05-15).
 *
 * Mirrors `verify-email.ts` deliberately so both flows share their security
 * posture: SHA-256 token-at-rest, prior tokens invalidated on re-request,
 * never throws to the caller, never logs the plaintext token.
 *
 * Why this mirrors instead of generalizing both flows into one module:
 *   - The two flows have different TTLs (24 h verify vs 1 h reset) and
 *     different rate limits (3/h verify vs 5/h reset — see the route).
 *   - Email templates and copy differ.
 *   - A bug in one MUST NOT silently affect the other; physical separation
 *     keeps the blast radius local. The cost is ~50 lines of duplicated
 *     glue, which is fine.
 *
 * Never throws. A broken email config (RESEND_API_KEY unset, network
 * blip) returns a structured `{ issued, send }` so the route handler can
 * log it. The user always sees "if your email is registered, we sent a
 * link" regardless of the underlying outcome — that's intentional, to
 * avoid becoming a user-enumeration oracle.
 */
import crypto from 'crypto';
import { db } from './db';
import { renderPasswordResetEmail, sendSystemEmail, type SendResult } from './email-system';

/**
 * 1-hour token validity. Tighter than the 24 h verify-email TTL because:
 *   - Reset tokens have higher impact (full account takeover vs email
 *     confirmation).
 *   - Industry standard (Auth0, Stripe, GitHub all use 1 h).
 *   - A user who legitimately forgot their password will check email
 *     within minutes; if they wait >1 h, they can just request again.
 */
const RESET_TTL_MS = 60 * 60 * 1000;

export interface IssueAndSendResetResult {
  /** True if the DB row was written; false only on bizarre transient errors. */
  issued: boolean;
  /** Full Resend send result so the route can log delivery status. */
  send: SendResult | null;
}

/**
 * Issues a fresh password-reset token for the given user, invalidates any
 * prior unused tokens, and emails the link.
 *
 * The plaintext token is NEVER persisted; the row stores SHA-256 only. The
 * plaintext lives in two places: the email body (recipient's inbox), and the
 * URL the user clicks. A DB leak alone cannot drive a password reset —
 * the attacker would also need inbox access OR a captured email body.
 *
 * @param origin - canonical origin (no trailing slash) for the reset link.
 *   Caller resolves this from `NEXTAUTH_URL` or the inbound request.
 * @param requestIp - optional IP from `x-forwarded-for` for audit; never
 *   shown to the user, only surfaces if an operator investigates a
 *   suspicious reset.
 */
export async function issueAndSendPasswordResetEmail(opts: {
  userId: string;
  email: string;
  name: string | null;
  origin: string;
  requestIp?: string | null;
}): Promise<IssueAndSendResetResult> {
  const { userId, email, name, origin, requestIp } = opts;

  // Invalidate prior unused tokens so a stale link in an old email becomes
  // useless once a fresh request is made. We delete (rather than mark used)
  // so the indexed lookup stays cheap — token rows are short-lived.
  try {
    await db.passwordResetToken.deleteMany({
      where: { userId, usedAt: null },
    });
  } catch {
    // Cleanup failure is non-fatal — duplicate active tokens are still
    // single-use thanks to the `usedAt` check in the confirm endpoint.
  }

  const plaintext = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');

  let issued = false;
  try {
    await db.passwordResetToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
        requestIp: requestIp?.slice(0, 64) ?? null,
      },
    });
    issued = true;
  } catch {
    return { issued: false, send: null };
  }

  // The URL is a GET-able page (not the API endpoint) so the user lands
  // on a form to type their new password. The page POSTs the token + new
  // password to /api/auth/password-reset/confirm.
  const resetUrl = `${origin.replace(/\/$/, '')}/reset-password/${plaintext}`;
  const { subject, html, text } = renderPasswordResetEmail({
    name: name ?? '',
    resetUrl,
  });

  const send = await sendSystemEmail({
    to: email,
    subject,
    html,
    text,
    tag: 'password_reset',
  });

  return { issued, send };
}

/**
 * Verifies a plaintext token and returns the associated User (or null on any
 * failure). Pure read — does NOT mark the token used. The confirm endpoint
 * calls this first to validate, THEN updates the password + marks used
 * inside a transaction so a crash between the two can't leave a half-
 * applied state.
 */
export async function findUserByResetToken(plaintext: string): Promise<{
  userId: string;
  tokenId: string;
} | null> {
  if (!plaintext || plaintext.length < 16) return null;

  const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');

  let row: { id: string; userId: string; expiresAt: Date; usedAt: Date | null } | null;
  try {
    row = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });
  } catch {
    return null;
  }

  if (!row) return null;
  if (row.usedAt) return null;            // single-use
  if (row.expiresAt < new Date()) return null; // expired
  return { userId: row.userId, tokenId: row.id };
}
