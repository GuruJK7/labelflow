import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { encrypt } from '@/lib/encryption';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/provisioning/dac-tenant
 *
 * Aprovisiona (o re-aprovisiona, idempotente) el Tenant DEDICADO de LabelFlow de
 * un cliente de AutoEnvía con sus credenciales DAC. Es la versión HTTP y
 * self-service del script manual `connect-dashboard-tenant.ts`.
 *
 * Modelo L: LabelFlow CUSTODIA (encripta AES-256-GCM, misma helper que la UI de
 * Settings) la password DAC y el dashboardToken. AutoEnvía nunca los guarda;
 * acá tampoco se loguean (el body trae secretos → no console.log del body).
 *
 * Idempotencia — un Tenant por cliente. Clave estable = slug determinístico
 * `ae-<sellerSlug>` (Tenant.slug es único). El User se ancla por `ownerEmail`
 * (User.email es único). Para la población objetivo (clientes self-service que
 * sólo existen vía AutoEnvía) el tenant `ae-*` es el ÚNICO del user → es su
 * credit-holder (tenant más viejo), así que isActive + créditos + config de
 * dashboard viven en la MISMA fila que lee el scheduler (evita el "holder trap").
 *
 * Gate del scheduler (verificado en apps/worker/src/jobs/scheduler.ts): además
 * de dashboardSourceEnabled + dashboardUrl/Token + dacUser/Pass, exige
 * `holder.isActive && balance>0`. isActive default=false y sólo lo prende el
 * webhook de suscripción MP → por eso acá se setea `isActive:true` EXPLÍCITO,
 * sino el job nunca se encola. shipmentCredits queda en el default 10 (bono).
 *
 * ── CUENTAS OPERADAS POR EL DEPÓSITO (DEPO) — dos campos OPCIONALES ─────────
 * `operacion` y `envios` existen para un caso concreto: las marcas que guardan
 * mercadería en DEPO y despachan con su propia cuenta de DAC. Ahí el que aprieta
 * el botón es el depósito, no el comerciante — que ni siquiera puede entrar a
 * LabelFlow (el User que se crea abajo no tiene passwordHash).
 *
 *   · `operacion: 'manual'` → escribe `cronSchedule: 'manual'`. NO es un valor
 *     mágico ni un flag nuevo: el scheduler descarta cualquier tenant cuyo cron
 *     no tenga los 5 campos (`scheduler.ts`, `cronSchedule.trim().split(...).length < 5`),
 *     así que un cron de una sola palabra lo deja fuera del barrido automático
 *     sin tocar una línea del worker. El disparo manual (`/api/v1/control/run`)
 *     NO mira el cron, así que sigue andando.
 *   · `envios: N` → `shipmentCredits`. Estas cuentas las factura el depósito,
 *     no AutoEnvía, así que el saldo no es un límite de cobro sino un tope
 *     técnico que no tiene que llegar nunca a cero (el job de la fuente
 *     dashboard RECORTA la tanda por saldo, no sólo se frena).
 *
 * 🔴 LOS DOS SON OPCIONALES Y SIN ELLOS NO CAMBIA NADA. Es deliberado: el
 * tenant de VentaFlow (`ae-adrijk7-cr`) se aprovisionó por esta misma ruta y
 * DEBE seguir despachando solo cada 15 minutos con su saldo real.
 *
 * Auth (máquina-a-máquina):
 *   Authorization: Bearer <AUTOENVIA_PROVISION_TOKEN>        (obligatorio, fail-closed)
 *   Si AUTOENVIA_PROVISION_SIGNING_KEY está seteada, exige además (opt-in):
 *     X-Timestamp: <ms epoch>
 *     X-Signature: HMAC-SHA256(key, `${ts}.${rawBody}`) hex  (ventana ±5 min)
 *   Estos deben espejar LABELFLOW_PROVISION_TOKEN / _SIGNING_KEY en AutoEnvía.
 */

const NOSTORE = { 'Cache-Control': 'no-store' };
const json = (b: object, status = 200) => NextResponse.json(b, { status, headers: NOSTORE });

/** Constant-time compare vía SHA-256 (sortea la restricción de igual-largo de
 *  timingSafeEqual y no filtra el largo del secreto). Patrón de lib/client-view.ts. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerOk(req: Request): boolean {
  const expected = process.env.AUTOENVIA_PROVISION_TOKEN?.trim();
  if (!expected) return false; // fail-closed: sin token configurado, se rechaza todo
  const header = req.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return false;
  return safeEqual(presented, expected);
}

/** Verifica la firma HMAC sólo si la signing key está configurada (opt-in
 *  simétrico con AutoEnvía). `rawBody` = bytes EXACTOS que AutoEnvía firmó. */
function signatureOk(req: Request, rawBody: string): boolean {
  const key = process.env.AUTOENVIA_PROVISION_SIGNING_KEY?.trim();
  if (!key) return true; // HMAC desactivado → bearer-only
  const ts = req.headers.get('x-timestamp') || '';
  const sig = req.headers.get('x-signature') || '';
  if (!ts || !sig) return false;
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) return false; // anti-replay
  const expected = crypto.createHmac('sha256', key).update(`${ts}.${rawBody}`).digest('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cliente'
  );
}

export async function POST(req: Request) {
  // Raw body ANTES de parsear: la firma HMAC cubre estos bytes exactos.
  const rawBody = await req.text();

  if (!bearerOk(req)) return json({ error: 'Unauthorized' }, 401);
  if (!signatureOk(req, rawBody)) return json({ error: 'Bad signature' }, 401);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }

  const sellerSlug = str(body.sellerSlug);
  const ownerEmail = str(body.ownerEmail).toLowerCase();
  const dacUsername = str(body.dacUsername); // = cédula (login DAC)
  const dacPassword = str(body.dacPassword);
  const dashboardUrl = str(body.dashboardUrl);
  const dashboardToken = str(body.dashboardToken);
  // dacAccount: AutoEnvía lo manda, pero LabelFlow no tiene columna ni concepto de
  // sub-cuenta (el login DAC es username+password). Se acepta y se IGNORA.

  // Cuentas operadas por el depósito (ver el encabezado). Los dos son opcionales
  // y cualquier valor raro se ignora en silencio: un provisioning que rebota por
  // un campo accesorio deja al cliente sin cuenta por nada.
  const soloManual = str(body.operacion).toLowerCase() === 'manual';
  const enviosPedidos = typeof body.envios === 'number' && Number.isInteger(body.envios) ? body.envios : null;
  // Tope en el máximo de un int4 de Postgres menos margen: `shipmentCredits` es
  // Int, y un número más grande revienta el insert con un error de rango que no
  // dice nada útil. El piso es 0 (no negativos: el gate compara `> 0`).
  const envios = enviosPedidos === null ? null : Math.min(Math.max(enviosPedidos, 0), 2_000_000_000);

  if (!ownerEmail || !EMAIL_RE.test(ownerEmail)) return json({ error: 'ownerEmail inválido' }, 400);
  if (!dacUsername || !dacPassword) return json({ error: 'faltan credenciales DAC' }, 400);
  if (!dashboardToken) return json({ error: 'falta dashboardToken' }, 400);
  if (!/^https?:\/\//i.test(dashboardUrl)) return json({ error: 'dashboardUrl inválido' }, 400);

  // Config de dashboard + DAC (encriptada). isActive + dashboardSourceEnabled son
  // OBLIGATORIOS o el scheduler nunca encola el job de esta fuente.
  const config = {
    dashboardUrl,
    dashboardToken: encrypt(dashboardToken),
    dashboardSourceEnabled: true,
    dacUsername: encrypt(dacUsername),
    dacPassword: encrypt(dacPassword),
    isActive: true,
    // Sólo se agregan si vinieron. Omitidos, Prisma no toca la columna: un
    // re-aprovisionamiento sin estos campos no le pisa el cron ni el saldo a
    // una cuenta que ya estaba andando.
    ...(soloManual ? { cronSchedule: 'manual' } : {}),
    ...(envios !== null ? { shipmentCredits: envios } : {}),
  };

  const slug = `ae-${slugify(sellerSlug || ownerEmail.split('@')[0])}`;

  try {
    // 1) User DEDICADO por cliente AutoEnvía (email sintético namespaceado por el
    //    slug). NO usamos el ownerEmail real: si coincide con un usuario LabelFlow
    //    existente (p.ej. el operador tiene tiendas Shopify), el tenant ae- quedaría
    //    bajo ese usuario y su credit-holder sería el tenant MÁS VIEJO (holder trap):
    //    el scheduler leería isActive/créditos de ese otro tenant y NUNCA encolaría
    //    el job de esta fuente. Con un usuario dedicado, el tenant ae- es SU PROPIO
    //    holder → isActive:true + créditos se leen de él. Sin passwordHash (no loguea).
    const provisionEmail = `${slug}@autoenvia.provision`;
    const user = await db.user.upsert({
      where: { email: provisionEmail },
      create: { email: provisionEmail, name: `AutoEnvía · ${sellerSlug || ownerEmail}` },
      update: {},
      select: { id: true },
    });

    // 2) Un Tenant por cliente: buscar por el slug determinístico (único).
    const found = await db.tenant.findUnique({ where: { slug }, select: { id: true, userId: true } });
    if (found) {
      // Guarda anti-hijack: si el slug ya pertenece a OTRO user, no lo tocamos.
      if (found.userId !== user.id) return json({ error: 'slug ya asignado a otra cuenta' }, 409);
      const t = await db.tenant.update({ where: { id: found.id }, data: config, select: { id: true } });
      return json({ tenantId: t.id });
    }

    // 3) Alta. `shipmentCredits` sale de `config` cuando vino `envios`; si no,
    //    queda en el default (10 = bono de bienvenida).
    try {
      const t = await db.tenant.create({
        data: {
          userId: user.id,
          name: `AutoEnvía · ${sellerSlug || ownerEmail}`,
          slug,
          apiKey: crypto.randomBytes(32).toString('hex'),
          tosAcceptedAt: new Date(),
          onboardingComplete: true,
          ...config,
        },
        select: { id: true },
      });
      return json({ tenantId: t.id });
    } catch (e) {
      // Carrera: dos requests concurrentes crearon el mismo slug (P2002). El
      // perdedor re-lee por slug y actualiza → idempotente.
      if ((e as { code?: string }).code === 'P2002') {
        const raced = await db.tenant.findUnique({ where: { slug }, select: { id: true, userId: true } });
        if (raced && raced.userId === user.id) {
          const t = await db.tenant.update({ where: { id: raced.id }, data: config, select: { id: true } });
          return json({ tenantId: t.id });
        }
      }
      throw e;
    }
  } catch (e) {
    // No logueamos el error crudo ni el body (podrían arrastrar secretos). Sólo
    // el código/clase para diagnóstico.
    console.error('[provisioning/dac-tenant] failed', (e as { code?: string }).code ?? (e as Error).name);
    return json({ error: 'provisioning_failed' }, 500);
  }
}
