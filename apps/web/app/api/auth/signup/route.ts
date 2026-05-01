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
import { issueAndSendVerificationEmail, resolveAppOrigin } from '@/lib/verify-email';
import { trackServer } from '@/lib/analytics.server';

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

    // Bono de referido para el referee: si entró con un código válido (cookie
    // firmada, no body), arranca con 10 envíos GRATIS extra en un pool
    // separado (`referralBonusCredits`). El worker drena ese pool primero al
    // despachar — el saldo pago (`shipmentCredits`, que ya viene con 10 por
    // signup universal) queda intacto hasta que el bonus se agote. Pareo con
    // el kickback del 20% al referrer (mercadopago/route.ts:415-481).
    const REFEREE_BONUS_CREDITS = 10;
    const refereeBonus = referredById ? REFEREE_BONUS_CREDITS : 0;

    // Create user + tenant in transaction (Prisma maneja la atomicidad
    // dentro de un solo create con nested write).
    //
    // Multi-store schema (2026-05-01): User.tenant (1:1) → User.tenants
    // (1:N). Signup creates exactly ONE tenant — the user's first store —
    // and additional stores get added later via POST /api/v1/tenants.
    const user = await db.user.create({
      data: {
        email,
        name,
        passwordHash,
        tenants: {
          create: [
            {
              name,
              slug: baseSlug,
              apiKey: crypto.randomBytes(32).toString('hex'),
              signupIp,
              tosAcceptedAt: new Date(),
              referralCode: myReferralCode,
              referredByCode,
              referredById,
              // shipmentCredits arranca en 10 por el @default del schema
              // (bonus universal de signup, no específico de referidos).
              // referralBonusCredits SÓLO se setea si el signup vino vía
              // referral válido — defaults a 0 para signups directos.
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
    const firstTenantId = user.tenants[0]?.id;

    // Fire #4 signup_completed BEFORE the email send so an outbound
    // SMTP hiccup doesn't drop the analytics event. distinct_id is the
    // tenantId — same id the client will see post-login when
    // IdentifyOnAuth runs, so the funnel stitches correctly. NO email,
    // name, or any PII in properties.
    if (firstTenantId) {
      await trackServer(firstTenantId, 'signup_completed', {
        method: 'email',
        has_referral: Boolean(referredById),
      });
    }

    // Fire the email-verification message. Best-effort:
    //   - If `RESEND_API_KEY` is unset (preview / local) the helper soft-
    //     fails and we still return 201 — signup must not depend on email.
    //   - If Resend is briefly unavailable, the user can re-trigger from
    //     the /verify-email page (rate-limited to 3/hr per address).
    //   - The verification GATE itself is env-flagged
    //     (`EMAIL_VERIFICATION_REQUIRED`) so an unwired email pipeline
    //     doesn't lock users out of the dashboard.
    let emailSent = false;
    try {
      await issueAndSendVerificationEmail({
        userId: user.id,
        email: user.email,
        name: user.name,
        origin: resolveAppOrigin(req),
      });
      emailSent = true;
    } catch {
      // Truly belt-and-suspenders — the helper itself doesn't throw, but
      // we don't trust transitive dependencies (Prisma, fetch) to never
      // raise. A failed email must NEVER take down a successful signup.
    }

    // Fire #5 only when the SMTP send actually succeeded — otherwise the
    // funnel would show "verification sent" for users who never got a
    // mail. Skipped entirely for OAuth signups (auto-verified via
    // emailVerified: now() in auth.ts).
    if (emailSent && firstTenantId) {
      await trackServer(firstTenantId, 'email_verification_sent');
    }

    return NextResponse.json(
      { data: { userId: user.id, tenantId: firstTenantId } },
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
