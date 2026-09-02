import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getRedis } from '@/lib/redis';
import { issueAndSendVerificationEmail, resolveAppOrigin } from '@/lib/verify-email';
import { getRequestIp, rateLimitBucketForIp } from '@/lib/rate-limit-ip';

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
 * Rate limit (Redis, compartido entre lambdas), tres topes (D25, D26):
 *   - 20/h por IP (IPv6 agrupada por /64, `rateLimitBucketForIp`), que se
 *     chequea primero y NO consume los contadores del email;
 *   - 3/h por email (el de siempre);
 *   - 5/día por email (`verify-email:rl:day:<email>`, TTL 24 h).
 * El tope diario existe porque cualquiera puede registrar un email ajeno y,
 * como esa cuenta queda sin verificar, este endpoint le reenviaba a esa
 * casilla hasta 72 mails por día desde `noreply@autoenvia.com`: acoso y
 * quejas de spam contra el dominio. Fail-open logueado si Redis no está.
 *
 * SECURITY:
 *   - Token plaintext lives only in the email body and the URL the user
 *     clicks. We persist SHA-256 only — DB dump can't be replayed.
 *   - Constant-shape response across "user exists / verified / missing".
 */

export const runtime = 'nodejs';

const RATE_LIMIT_TTL = 60 * 60; // 1 h
const RATE_LIMIT_MAX = 3; // por email y hora
const RATE_LIMIT_DAY_TTL = 24 * 60 * 60; // 24 h
const RATE_LIMIT_DAY_MAX = 5; // por email y día (D26)
const RATE_LIMIT_IP_MAX = 20; // por IP (/64 en IPv6) y hora (D26)

const sendSchema = z.object({
  email: z.string().email().max(254),
});

type SendVerdict = 'ok' | 'ip' | 'hour' | 'day';

async function checkSendRateLimit(email: string, ip: string): Promise<SendVerdict> {
  const redis = getRedis();
  if (!redis) {
    console.warn('[verify-email/send] rate limit fail-open: sin REDIS_URL, el reenvío no se limita');
    return 'ok';
  }

  const ipKey = `verify-email:rl:ip:${rateLimitBucketForIp(ip)}`;
  const hourKey = `verify-email:rl:${email}`;
  const dayKey = `verify-email:rl:day:${email}`;
  try {
    // La IP va primero y aparte: una red bloqueada no gasta la cuota del
    // email de nadie.
    const perIp = await redis.pipeline().incr(ipKey).expire(ipKey, RATE_LIMIT_TTL).exec();
    const ipCount = (perIp?.[0]?.[1] as number) ?? 1;
    if (ipCount > RATE_LIMIT_IP_MAX) return 'ip';

    const perEmail = await redis
      .pipeline()
      .incr(hourKey)
      .expire(hourKey, RATE_LIMIT_TTL)
      .incr(dayKey)
      .expire(dayKey, RATE_LIMIT_DAY_TTL)
      .exec();
    const hourCount = (perEmail?.[0]?.[1] as number) ?? 1;
    const dayCount = (perEmail?.[2]?.[1] as number) ?? 1;
    if (hourCount > RATE_LIMIT_MAX) return 'hour';
    if (dayCount > RATE_LIMIT_DAY_MAX) return 'day';
    return 'ok';
  } catch (err) {
    console.warn('[verify-email/send] rate limit fail-open: Redis no respondió', {
      message: err instanceof Error ? err.message : String(err),
    });
    return 'ok';
  }
}

const RATE_LIMIT_MESSAGES: Record<Exclude<SendVerdict, 'ok'>, string> = {
  ip: 'Demasiados intentos desde esta red. Esperá una hora e intentá de nuevo.',
  hour: 'Demasiados intentos. Esperá una hora antes de pedir otro mail.',
  day: 'Ya reenviamos el mail de confirmación varias veces hoy. Revisá la carpeta de spam o escribinos por WhatsApp.',
};

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
  const verdict = await checkSendRateLimit(email, getRequestIp(req));
  if (verdict !== 'ok') {
    return NextResponse.json({ error: RATE_LIMIT_MESSAGES[verdict] }, { status: 429 });
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
