import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getRedis } from '@/lib/redis';
import { issueAndSendVerificationEmail, resolveAppOrigin } from '@/lib/verify-email';

/**
 * POST /api/auth/verify-email/send
 *
 * Issues (or re-issues) an email-verification token and emails the link.
 * Used from the /verify-email page when the user clicks "Reenviar email".
 *
 * Auth: INTENTIONALLY unauthenticated by session — at signup time the
 * user does not have a session yet (they'll log in after verifying).
 * To avoid becoming a user-enumeration oracle, the response is always
 * `{ ok: true }` regardless of whether the email matched a real user
 * or whether the user was already verified.
 *
 * Rate-limit: max 3 sends per email per hour (Redis). Falls open if Redis
 * is unavailable (same posture as `/api/v1/chat`).
 *
 * SECURITY:
 *   - Token plaintext lives only in the email body and the URL the user
 *     clicks. We persist SHA-256 only — DB dump can't be replayed.
 *   - Constant-shape response across "user exists / verified / missing".
 */

export const runtime = 'nodejs';

const RATE_LIMIT_TTL = 60 * 60; // 1 h
const RATE_LIMIT_MAX = 3;

const sendSchema = z.object({
  email: z.string().email().max(254),
});

async function checkSendRateLimit(email: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true; // fail open

  const key = `verify-email:rl:${email.toLowerCase()}`;
  try {
    const results = await redis.pipeline().incr(key).expire(key, RATE_LIMIT_TTL).exec();
    const count = (results?.[0]?.[1] as number) ?? 1;
    return count <= RATE_LIMIT_MAX;
  } catch {
    return true;
  }
}

export async function POST(req: Request) {
  let parsed: z.infer<typeof sendSchema>;
  try {
    const body = await req.json();
    const result = sendSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json({ error: 'Email inválido' }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 });
  }

  const email = parsed.email.toLowerCase();

  // Rate-limit BEFORE the DB lookup so probing a valid email costs the
  // same as probing an invalid one.
  const rlOk = await checkSendRateLimit(email);
  if (!rlOk) {
    return NextResponse.json(
      { error: 'Demasiados intentos. Esperá una hora antes de pedir otro mail.' },
      { status: 429 }
    );
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, emailVerified: true },
  });

  // Always return `{ ok: true }` from here on — see header comment.
  if (!user) return NextResponse.json({ ok: true });
  if (user.emailVerified) return NextResponse.json({ ok: true });

  await issueAndSendVerificationEmail({
    userId: user.id,
    email: user.email,
    name: user.name,
    origin: resolveAppOrigin(req),
  });

  return NextResponse.json({ ok: true });
}
