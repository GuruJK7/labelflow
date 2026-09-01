import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { getRedis } from '@/lib/redis';
import {
  isValidReferralCodeShape,
  readReferralCookieValue,
  REFERRAL_COOKIE_NAME,
} from '@/lib/referrals';
import { nuevoTenantBase } from '@/lib/tenant-provision';
import { issueAndSendVerificationEmail, resolveAppOrigin } from '@/lib/verify-email';
import { trackServer } from '@/lib/analytics.server';
import { rateLimitBucketForIp } from '@/lib/rate-limit-ip';

export const runtime = 'nodejs';

const signupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Normalización (D25): sin espacios en los bordes y en minúsculas ANTES de
  // validar, así "  Juan@Gmail.com " y "juan@gmail.com" son la misma cuenta
  // (el 409 de duplicado y el login comparan contra lo guardado). Un espacio
  // en el medio no se arregla: se rechaza.
  email: z
    .string()
    .max(254)
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.string().email().refine((s) => !/\s/.test(s))),
  password: z.string().min(8).max(100),
  tosAccepted: z.literal(true, {
    errorMap: () => ({
      message: 'Tenés que aceptar los Términos de Servicio y la Política de Privacidad',
    }),
  }),
  // El body NUNCA es authoritative para referralCode — sólo lo aceptamos
  // como hint para mejor UX en el form. La atribución real viene de la
  // cookie firmada `lf_ref` (HMAC). Mantener el campo opcional por compat.
  referralCode: z.string().nullable().optional(),
});

// Gate del alta pública (D23). Default = bloqueado: sin ALLOW_PUBLIC_SIGNUP=true
// nadie puede POSTear y conseguir una cuenta, aunque el form de /signup esté
// visible. La bandera la maneja el operador en Vercel.
function isPublicSignupEnabled(): boolean {
  return (process.env.ALLOW_PUBLIC_SIGNUP ?? '').toLowerCase() === 'true';
}

// Rate limit por IP + tope global (D25, D26). Mismo mecanismo que
// password-reset/request y verify-email/send: contador en Redis (Upstash,
// compartido entre instancias de Vercel) con INCR + EXPIRE. Fail-open: sin
// REDIS_URL o con Redis caído no se limita nada — preferimos un alta de más a
// bloquear a un cliente real — pero se loguea, para que un Redis ausente en
// prod no deje el alta sin límite en silencio. NO es en memoria: el contador
// es el mismo para todas las lambdas.
const RATE_LIMIT_TTL = 60 * 60; // 1 h
const RATE_LIMIT_MAX = 5; // 5 altas por IP por hora: una familia/oficina entera cabe
// Tope global (D26): es el kill-switch barato contra un script que rota IPs.
// Acota el peor caso a ~40/h ≈ 1.000 altas/día pase lo que pase con las IPs
// (cada alta = User + Tenant + 10 créditos + un mail por Resend). Sólo se
// incrementa cuando la IP pasó su propio límite, así una sola IP bloqueada
// no puede agotar el tope de todos.
const RATE_LIMIT_GLOBAL_MAX = 40;

type RateLimitVerdict = 'ok' | 'ip' | 'global';

async function checkSignupRateLimit(ip: string): Promise<RateLimitVerdict> {
  const redis = getRedis();
  if (!redis) {
    console.warn('[signup] rate limit fail-open: sin REDIS_URL, el alta no se limita');
    return 'ok';
  }

  const ipKey = `signup:rl:ip:${rateLimitBucketForIp(ip)}`;
  const globalKey = 'signup:rl:global';
  try {
    const perIp = await redis.pipeline().incr(ipKey).expire(ipKey, RATE_LIMIT_TTL).exec();
    const ipCount = (perIp?.[0]?.[1] as number) ?? 1;
    if (ipCount > RATE_LIMIT_MAX) return 'ip';

    const global = await redis
      .pipeline()
      .incr(globalKey)
      .expire(globalKey, RATE_LIMIT_TTL)
      .exec();
    const globalCount = (global?.[0]?.[1] as number) ?? 1;
    return globalCount > RATE_LIMIT_GLOBAL_MAX ? 'global' : 'ok';
  } catch (err) {
    console.warn('[signup] rate limit fail-open: Redis no respondió', {
      message: err instanceof Error ? err.message : String(err),
    });
    return 'ok';
  }
}

/** Primer salto de x-forwarded-for (Vercel lo escribe él mismo), si no x-real-ip. */
function getRequestIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

/** Prisma P2002 = violación de unique. Duck-typing para no importar @prisma/client acá. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

export async function POST(req: Request) {
  if (!isPublicSignupEnabled()) {
    return NextResponse.json(
      {
        error:
          'El registro público está cerrado por ahora. Escribinos por WhatsApp y te creamos la cuenta.',
      },
      { status: 403 },
    );
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
    }

    // Honeypot (D25): el form manda `website` desde un input que ningún humano
    // ve ni alcanza con Tab. Si viene con valor es un bot que rellenó todo:
    // respondemos 200 con la misma forma que un alta real y no tocamos la
    // base, para que el bot no sepa que lo detectamos.
    const website = (body as { website?: unknown } | null)?.website;
    if (typeof website === 'string' && website.trim() !== '') {
      return NextResponse.json({ data: { ok: true } }, { status: 200 });
    }

    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) {
      const tosIssue = parsed.error.issues.find((i) => i.path[0] === 'tosAccepted');
      return NextResponse.json(
        {
          error: tosIssue ? tosIssue.message : 'Datos inválidos',
          details: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const { name, email, password } = parsed.data;

    // Capture IP for legal compliance (Ley 18.331) + rate limit.
    const signupIp = getRequestIp(req);

    const verdict = await checkSignupRateLimit(signupIp);
    if (verdict === 'ip') {
      return NextResponse.json(
        { error: 'Demasiados intentos desde esta red. Esperá una hora e intentá de nuevo.' },
        { status: 429 },
      );
    }
    if (verdict === 'global') {
      return NextResponse.json(
        {
          error:
            'Estamos recibiendo muchas altas en este momento. Esperá un rato e intentá de nuevo, o escribinos por WhatsApp.',
        },
        { status: 429 },
      );
    }

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

    // Check if user exists
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: 'Ya existe una cuenta con ese email. Iniciá sesión o recuperá tu contraseña.' },
        { status: 409 },
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
      if (referrer && referrer.user?.email?.toLowerCase() !== email) {
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
    // apiKey aleatoria + referralCode libre. Mismo helper que usa el alta
    // desde el Shopify App Store, para que ningún camino de alta quede con
    // una apiKey adivinable (cuid) o sin código de referido.
    const base = await nuevoTenantBase(db, baseSlug);

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
    let user: { id: string; email: string; name: string | null; tenants: { id: string }[] };
    try {
      user = await db.user.create({
        data: {
          email,
          name,
          passwordHash,
          tenants: {
            create: [
              {
                name,
                slug: baseSlug,
                apiKey: base.apiKey,
                signupIp,
                tosAcceptedAt: new Date(),
                referralCode: base.referralCode,
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
    } catch (err) {
      // Dos POST simultáneos con el mismo email pasan los dos el findUnique
      // de arriba; el índice único de User.email frena al segundo. Es el
      // mismo caso que el 409 de arriba, no un 500.
      if (isUniqueViolation(err)) {
        return NextResponse.json(
          { error: 'Ya existe una cuenta con ese email. Iniciá sesión o recuperá tu contraseña.' },
          { status: 409 },
        );
      }
      throw err;
    }
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
      const r = await issueAndSendVerificationEmail({
        userId: user.id,
        email: user.email,
        name: user.name,
        origin: resolveAppOrigin(req),
      });
      emailSent = Boolean(r?.send?.ok);
    } catch {
      // Truly belt-and-suspenders — the helper itself doesn't throw, but
      // we don't trust transitive dependencies (Prisma, fetch) to never
      // raise. A failed email must NEVER take down a successful signup.
    }

    // Fire #5 only when the send actually succeeded — otherwise the
    // funnel would show "verification sent" for users who never got a
    // mail. Skipped entirely for OAuth signups (auto-verified via
    // emailVerified: now() in auth.ts).
    if (emailSent && firstTenantId) {
      await trackServer(firstTenantId, 'email_verification_sent');
    }

    return NextResponse.json(
      { data: { userId: user.id, tenantId: firstTenantId } },
      { status: 201 },
    );
  } catch (err) {
    // Do not log error details to prevent info leakage
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 });
  }
}
