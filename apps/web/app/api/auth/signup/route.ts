import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '@/lib/db';
import {
  generateReferralCode,
  isValidReferralCodeShape,
  readReferralCookieValue,
  REFERRAL_COOKIE_NAME,
} from '@/lib/referrals';

const signupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  tosAccepted: z.literal(true, {
    errorMap: () => ({ message: 'Debes aceptar los Terminos de Servicio y la Politica de Privacidad' }),
  }),
  // El body NUNCA es authoritative para referralCode — sólo lo aceptamos
  // como hint para mejor UX en el form. La atribución real viene de la
  // cookie firmada `lf_ref` (HMAC). Mantener el campo opcional por compat.
  referralCode: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = signupSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Datos invalidos', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { name, email, password } = parsed.data;

    // Atribución de referido: SÓLO desde la cookie firmada (HMAC). El body
    // se ignora — un atacante podría POST-ear cualquier código y atribuirse
    // referidos falsos. La cookie la setea el cliente cuando llega a
    // /signup?ref=<code>, firmada por NEXTAUTH_SECRET.
    const cookieHeader = req.headers.get('cookie') ?? '';
    const cookieMatch = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${REFERRAL_COOKIE_NAME}=`));
    const cookieRaw = cookieMatch
      ? decodeURIComponent(cookieMatch.slice(REFERRAL_COOKIE_NAME.length + 1))
      : null;
    const referralCode = readReferralCookieValue(cookieRaw);

    // Capture IP for legal compliance (Ley 18.331)
    const signupIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      'unknown';

    // Check if user exists
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: 'Ya existe una cuenta con ese email' },
        { status: 409 }
      );
    }

    // Resolver referidor (si vino con ?ref=<code>) ANTES de crear el tenant
    // para poder setear referredById en la creación. Validamos forma + email
    // distinto (no auto-referidos por email aunque no podamos garantizar
    // 100% — no hay manera de detectar familia/multi-cuenta).
    let referredByCode: string | null = null;
    let referredById: string | null = null;
    if (referralCode && isValidReferralCodeShape(referralCode)) {
      const referrer = await db.tenant.findUnique({
        where: { referralCode },
        select: { id: true, userId: true, user: { select: { email: true } } },
      });
      if (referrer && referrer.user?.email?.toLowerCase() !== email.toLowerCase()) {
        referredByCode = referralCode;
        referredById = referrer.id;
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Slug + código de referido propio (con reintentos por colisión)
    const baseSlug =
      email.split('@')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase() +
      '-' +
      Date.now().toString(36);
    let myReferralCode: string | null = null;
    for (let attempt = 0; attempt < 5 && !myReferralCode; attempt++) {
      const candidate = generateReferralCode(baseSlug);
      const collision = await db.tenant.findUnique({
        where: { referralCode: candidate },
        select: { id: true },
      });
      if (!collision) myReferralCode = candidate;
    }

    // Create user + tenant in transaction (Prisma maneja la atomicidad
    // dentro de un solo create con nested write).
    const user = await db.user.create({
      data: {
        email,
        name,
        passwordHash,
        tenant: {
          create: {
            name,
            slug: baseSlug,
            apiKey: crypto.randomBytes(32).toString('hex'),
            signupIp,
            tosAcceptedAt: new Date(),
            referralCode: myReferralCode,
            referredByCode,
            referredById,
            // shipmentCredits arranca en 10 por el @default del schema
          },
        },
      },
      include: { tenant: true },
    });

    return NextResponse.json(
      { data: { userId: user.id, tenantId: user.tenant?.id } },
      { status: 201 }
    );
  } catch (err) {
    // Do not log error details to prevent info leakage
    return NextResponse.json(
      { error: 'Error interno del servidor' },
      { status: 500 }
    );
  }
}
