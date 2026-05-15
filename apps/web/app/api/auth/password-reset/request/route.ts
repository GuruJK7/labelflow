/**
 * POST /api/auth/password-reset/request
 *
 * Requests a password-reset email for the given address. Always returns
 * `{ ok: true }` regardless of whether the email matched a real user —
 * this is INTENTIONAL to prevent user-enumeration attacks. An attacker
 * can't probe the system to discover which emails have accounts.
 *
 * Rate-limit: max 5 requests per email per hour (Redis). Falls open if
 * Redis is unavailable — same posture as the verify-email/send route.
 *
 * SECURITY:
 *   - Token plaintext lives only in the email body and the URL the user
 *     clicks. We persist SHA-256 only — a DB dump can't be replayed.
 *   - The response shape is identical for "user exists" / "user missing" /
 *     "user already deleted" — the network observer can't tell.
 *   - We record requestIp for audit (in `PasswordResetToken.requestIp`)
 *     but NEVER include it in the email body or response.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getRedis } from '@/lib/redis';
import { issueAndSendPasswordResetEmail } from '@/lib/password-reset';
import { resolveAppOrigin } from '@/lib/verify-email';

export const runtime = 'nodejs';

const RATE_LIMIT_TTL = 60 * 60;  // 1 h
const RATE_LIMIT_MAX = 5;        // 5 reset attempts/hour/email — slightly more
                                  // generous than verify-email (3/h) because
                                  // legitimate users forget passwords more
                                  // frequently than they need re-verification.

const requestSchema = z.object({
  email: z.string().email().max(254),
});

async function checkResetRateLimit(email: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true; // fail open — better than locking out a real user

  const key = `password-reset:rl:${email.toLowerCase()}`;
  try {
    const results = await redis.pipeline().incr(key).expire(key, RATE_LIMIT_TTL).exec();
    const count = (results?.[0]?.[1] as number) ?? 1;
    return count <= RATE_LIMIT_MAX;
  } catch {
    return true;
  }
}

/**
 * Extract the requester's IP for audit. We trust the first hop in
 * `x-forwarded-for` because Render/Vercel terminate TLS and append the
 * real client IP themselves. Behind a Cloudflare proxy we'd prefer
 * `cf-connecting-ip`, but neither hosting platform we use sets that.
 */
function getRequestIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') ?? null;
}

export async function POST(req: Request) {
  let parsed: z.infer<typeof requestSchema>;
  try {
    const body = await req.json();
    const result = requestSchema.safeParse(body);
    if (!result.success) {
      // Even validation errors return 200 for the same enumeration-safety
      // reason. The only signal an attacker gets is "form is malformed".
      return NextResponse.json({ ok: true });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const emailLower = parsed.email.toLowerCase();

  // Rate-limit BEFORE the user lookup so DB hits are bounded for an
  // attacker spraying emails.
  const allowed = await checkResetRateLimit(emailLower);
  if (!allowed) {
    return NextResponse.json({ ok: true });
  }

  // Look up the user. If they don't exist (or don't have a passwordHash —
  // OAuth-only account), we silently no-op and return the same shape.
  let user: { id: string; email: string; name: string | null; passwordHash: string | null } | null;
  try {
    user = await db.user.findUnique({
      where: { email: emailLower },
      select: { id: true, email: true, name: true, passwordHash: true },
    });
  } catch {
    return NextResponse.json({ ok: true });
  }

  // No matching user, OR user has no password (OAuth-only). Both look
  // identical to the caller — no information leaks.
  if (!user || !user.passwordHash) {
    return NextResponse.json({ ok: true });
  }

  const origin = resolveAppOrigin(req);
  const requestIp = getRequestIp(req);

  // Fire and respond — we don't need to await the email send for the
  // user-facing response, but we DO await here so any Resend failure
  // is logged (the function never throws — it returns a structured
  // result we can inspect).
  await issueAndSendPasswordResetEmail({
    userId: user.id,
    email: user.email,
    name: user.name,
    origin,
    requestIp,
  });

  return NextResponse.json({ ok: true });
}
