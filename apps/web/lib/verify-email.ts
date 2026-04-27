/**
 * Server-side helpers for the email-verification flow.
 *
 * Pulled into its own module so both the signup handler (POST
 * `/api/auth/signup`) and the resend endpoint (POST
 * `/api/auth/verify-email/send`) can issue tokens via the same code path
 * — instead of having signup HTTP-self-call the resend route, which would
 * burn a network round-trip and force the routes to share auth posture.
 *
 * Never throws. The signup flow MUST keep working even if Resend is down
 * or `RESEND_API_KEY` is unset (preview / local). The function returns a
 * structured result so callers can log it without surfacing it to the
 * user — the user always sees "check your inbox", and we let the resend
 * button cover the eventual flake.
 */

import crypto from 'crypto';
import { db } from './db';
import { renderVerificationEmail, sendSystemEmail, type SendResult } from './email-system';

/** 24-hour token validity. Long enough for a user who signed up at night
 *  to click the morning email; short enough that abandoned links rotate. */
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IssueAndSendResult {
  /** True if the DB row was written; false only on bizarre transient errors. */
  issued: boolean;
  /** Full Resend send result so callers can log delivery status. */
  send: SendResult | null;
}

/**
 * Issues a fresh verification token for the given user, invalidates any
 * prior unused tokens, and emails the link.
 *
 * @param origin - canonical origin (no trailing slash) for the verify link.
 *   Caller resolves this from `NEXTAUTH_URL` or the inbound request — we
 *   don't reach into request-scope here.
 */
export async function issueAndSendVerificationEmail(opts: {
  userId: string;
  email: string;
  name: string | null;
  origin: string;
}): Promise<IssueAndSendResult> {
  const { userId, email, name, origin } = opts;

  // Invalidate prior unused tokens — see EmailVerificationToken model
  // docstring for why we delete instead of marking as used.
  try {
    await db.emailVerificationToken.deleteMany({
      where: { userId, usedAt: null },
    });
  } catch {
    // If the cleanup fails we'd rather still issue a new token than block
    // the flow — duplicate active tokens are harmless (each is single-use).
  }

  const plaintext = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');

  let issued = false;
  try {
    await db.emailVerificationToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
      },
    });
    issued = true;
  } catch {
    return { issued: false, send: null };
  }

  const verifyUrl = `${origin.replace(/\/$/, '')}/api/auth/verify-email/${plaintext}`;
  const { subject, html, text } = renderVerificationEmail({
    name: name ?? '',
    verifyUrl,
  });

  const send = await sendSystemEmail({
    to: email,
    subject,
    html,
    text,
    tag: 'verify_email',
  });

  return { issued, send };
}

/**
 * Resolves the canonical origin for outbound links. Prefer NEXTAUTH_URL
 * (already validated for OAuth callbacks); fall back to the inbound URL
 * for preview deployments. Never trusts user-supplied `Host` blindly —
 * but on Vercel the URL passed to handlers is built from the platform's
 * own forwarded-host header, which is safe.
 */
export function resolveAppOrigin(req: Request): string {
  const fromEnv = process.env.NEXTAUTH_URL?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
