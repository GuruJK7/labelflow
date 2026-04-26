import { NextRequest, NextResponse } from 'next/server';
import {
  buildReferralCookieValue,
  isValidReferralCodeShape,
  REFERRAL_COOKIE_NAME,
  REFERRAL_COOKIE_MAX_AGE_SECONDS,
} from '@/lib/referrals';

/**
 * POST /api/referrals/track
 *
 * Setea una cookie firmada (HMAC sha256) con el código de referido. El
 * cliente la llama desde /signup?ref=<code> al primer render. La cookie es
 * authoritative — el handler de signup IGNORA cualquier código que venga
 * en el body del POST y sólo confía en esta cookie. Sin firma no hay
 * forma de spoofear atribución.
 *
 * Cuerpo: { code: string }
 * Respuesta: 204 (cookie en headers)
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const code = (body as { code?: unknown })?.code;
  if (typeof code !== 'string' || !isValidReferralCodeShape(code)) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 400 });
  }

  const value = buildReferralCookieValue(code);
  if (!value) {
    return NextResponse.json({ error: 'Invalid code' }, { status: 400 });
  }

  const res = new NextResponse(null, { status: 204 });
  res.cookies.set({
    name: REFERRAL_COOKIE_NAME,
    value,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}
