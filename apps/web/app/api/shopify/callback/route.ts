import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-utils';
import { db } from '@/lib/db';
import { encrypt } from '@/lib/encryption';
import {
  normalizeShopDomain,
  verifyOAuthHmac,
  statesMatch,
  missingScopes,
  STATE_COOKIE,
  TENANT_COOKIE,
  FLOW_COOKIE,
  FLOW_APPSTORE,
  PENDING_INSTALL_COOKIE,
  PENDING_INSTALL_PATH,
  PENDING_INSTALL_TTL_SECONDS,
} from '@/lib/shopify-oauth';
import { fetchShopInfo, provisionFromShopify } from '@/lib/shopify-provision';
import { sealPendingInstall } from '@/lib/shopify-pending-install';
import { issueAndSendPasswordResetEmail } from '@/lib/password-reset';
import { registerShopifyWebhooks } from '@/lib/shopify-register-webhooks';

export const dynamic = 'force-dynamic';

/**
 * GET /api/shopify/callback
 *
 * Paso 2 del "conectar con un botón". Shopify vuelve acá con `code`, `hmac`,
 * `shop`, `state` y `timestamp`. Hay dos ramas según de dónde nació el OAuth
 * (cookie FLOW): desde el dashboard (/install) o desde el App Store (/entry).
 *
 * ORDEN DE LAS VALIDACIONES — importa, y por eso está escrito.
 * Cada chequeo corre ANTES de cualquier I/O que dependa del anterior.
 *
 * Comunes a las dos ramas, en este orden:
 *   1. HMAC del query (autenticidad: esto lo mandó Shopify, no cualquiera).
 *   2. `state` contra la cookie (anti-CSRF: esta instalación la empezamos nosotros).
 *   3. Frescura del timestamp (anti-replay de un callback viejo interceptado).
 *   4. Dominio de tienda normalizado (anti open-redirect / SSRF).
 *   5. Coherencia de cookies: FLOW=appstore y TENANT a la vez es un flujo
 *      mezclado (una instalación abandonada del App Store más un "Conectar"
 *      del dashboard dentro de los 10 minutos) → se rechaza, no se adivina.
 *
 * Rama B (dashboard), ANTES de canjear el code:
 *   6. Sesión y propiedad del tenant (no conectar la tienda de otro).
 *   7. Reconectar no cambia el dominio (shop_mismatch).
 *   8. La tienda no está tomada por otro tenant (already_linked).
 *   9. Canje del code → token. Se guarda en el tenant elegido.
 *
 * Rama A (App Store):
 *   6. Canje del code → token. Acá va primero porque sin token no podemos
 *      preguntarle a Shopify de quién es la tienda.
 *   7. shop.json → email/nombre de la tienda.
 *   8. provisionFromShopify decide: created / existing / claim / conflict.
 *
 * POR QUÉ EL CANJE VA DESPUÉS EN LA RAMA B: un `code` canjeado emite un token
 * offline vivo para esa tienda. Si después el request falla por no_session o
 * not_owner, ese token queda emitido y descartado, sin dueño ni revocación.
 * Nada que pueda fallar por permisos debe correr después del canje.
 *
 * DESTINO DE LOS ERRORES: en la rama App Store no hay sesión, así que todo
 * (éxito y error) aterriza en /login?shopify=<motivo>, que es pública y sabe
 * mostrar el mensaje. /settings rebotaría al login perdiendo el motivo. Nunca
 * se pasa el email en la query: queda en logs y en el Referer.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;

  // Se lee primero porque decide a dónde van los errores. Es sólo una cookie:
  // ninguna de las validaciones de abajo depende de ella.
  const esAppStore = req.cookies.get(FLOW_COOKIE)?.value === FLOW_APPSTORE;
  const landing = esAppStore ? '/login' : '/settings';

  const limpiar = (r: NextResponse) => {
    // Las cookies se borran también al fallar: si no, un `state` ya expuesto
    // sigue siendo reusable hasta 10 minutos.
    r.cookies.delete(STATE_COOKIE);
    r.cookies.delete(TENANT_COOKIE);
    r.cookies.delete(FLOW_COOKIE);
    return r;
  };
  const fail = (motivo: string) =>
    limpiar(NextResponse.redirect(new URL(`${landing}?shopify=${motivo}`, origin)));

  const secret = process.env.SHOPIFY_API_SECRET;
  const clientId = process.env.SHOPIFY_API_KEY;
  if (!secret || !clientId) return fail('misconfigured');

  const params = req.nextUrl.searchParams;

  // 1. Autenticidad.
  if (!verifyOAuthHmac(params, secret)) return fail('bad_hmac');

  // 2. Anti-CSRF.
  const state = params.get('state');
  const cookieState = req.cookies.get(STATE_COOKIE)?.value ?? null;
  if (!statesMatch(state, cookieState)) return fail('bad_state');

  // 3. Anti-replay. Shopify manda el timestamp en segundos.
  const ts = Number(params.get('timestamp'));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return fail('stale');

  // 4. Dominio.
  const shop = normalizeShopDomain(params.get('shop'));
  if (!shop) return fail('bad_shop');

  const code = params.get('code');
  if (!code) return fail('no_code');

  // 5. Coherencia de cookies.
  const tenantId = req.cookies.get(TENANT_COOKIE)?.value;
  if (esAppStore && tenantId) return fail('bad_flow');

  // ── Rama B, parte 1: todo lo que puede fallar por permisos, ANTES del canje ─
  let tenantDashboard: { id: string; shopifyStoreUrl: string | null } | null = null;
  if (!esAppStore) {
    // 6. Sesión y propiedad. La cookie dice a qué tenant atar; el usuario
    // logueado tiene que ser dueño de ese tenant. Las dos condiciones, no una.
    const user = await getAuthenticatedUser();
    if (!user || !tenantId) return fail('no_session');

    tenantDashboard = await db.tenant.findFirst({
      where: { id: tenantId, userId: user.userId },
      select: { id: true, shopifyStoreUrl: true },
    });
    if (!tenantDashboard) return fail('not_owner');

    // 7. Reconectar puede cambiar el TOKEN, nunca el DOMINIO.
    //
    // Sin esto, alguien parado en la tienda A que escribe el dominio de una
    // tienda B y aprieta "Reconectar" deja al tenant A apuntando a B: el
    // cliente A deja de despachar y los pedidos de B salen con las credenciales
    // DAC y el saldo de A, en silencio y con la UI diciendo "Tienda conectada".
    if (tenantDashboard.shopifyStoreUrl && tenantDashboard.shopifyStoreUrl !== shop) {
      return fail('shop_mismatch');
    }

    // 8. Se repite el chequeo de "ya vinculada" que hizo /install: entre uno y
    // otro pasaron hasta 10 minutos y otro tenant pudo haber tomado el dominio.
    const tomadaPorOtro = await db.tenant.findFirst({
      where: { shopifyStoreUrl: shop, id: { not: tenantDashboard.id } },
      select: { id: true },
    });
    if (tomadaPorOtro) return fail('already_linked');
  }

  // Canje del code por el token de acceso offline.
  let accessToken: string;
  let grantedScopes: string;
  try {
    const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return fail('exchange_failed');
    const json = (await resp.json()) as { access_token?: string; scope?: string };
    if (!json.access_token) return fail('exchange_failed');
    accessToken = json.access_token;
    grantedScopes = json.scope ?? '';
  } catch {
    return fail('exchange_failed');
  }

  // Si el comerciante autorizó menos de lo necesario, avisamos ACÁ y no cuando
  // falle el primer despacho a las 3 de la mañana.
  const faltan = missingScopes(grantedScopes);
  if (faltan.length > 0) {
    return limpiar(
      NextResponse.redirect(
        new URL(`${landing}?shopify=missing_scopes&scopes=${encodeURIComponent(faltan.join(','))}`, origin),
      ),
    );
  }

  // ── Rama A: instalación desde el App Store ──────────────────────────────
  if (esAppStore) {
    const info = await fetchShopInfo(shop, accessToken);
    if (!info) return fail('shop_info_failed');

    const alta = await provisionFromShopify(info, accessToken);

    if (alta.kind === 'conflict') return fail('already_linked');

    if (alta.kind === 'claim') {
      // Ya hay cuenta con ese email: no le colgamos nada. El token viaja
      // cifrado en una cookie corta y el dueño lo reclama logueado (D11).
      // Se va DIRECTO a /claim, no al login: si el comerciante ya tiene
      // sesión (caso común: instala desde el mismo navegador donde usa
      // AutoEnvía) reclama en el acto. Sin sesión, /claim es el que manda a
      // /login?shopify=claim&next=/api/shopify/claim conservando la cookie.
      const r = limpiar(NextResponse.redirect(new URL('/api/shopify/claim', origin)));
      r.cookies.set(PENDING_INSTALL_COOKIE, sealPendingInstall({ shop, token: accessToken }), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: PENDING_INSTALL_PATH,
        maxAge: PENDING_INSTALL_TTL_SECONDS,
      });
      return r;
    }

    await registrarWebhooks(shop, accessToken, origin);

    // Enlace para definir contraseña, SÓLO para cuentas recién creadas (D12).
    // En una reinstalación o reapertura el comerciante ya tiene contraseña:
    // mandarle otro reset cada vez invalidaría la que tiene vigente y le
    // llenaría el inbox de "restablecer contraseña" que no pidió.
    //
    // Es best-effort a propósito: si el mail no sale, la cuenta YA quedó
    // creada y con la tienda conectada — el comerciante puede entrar por
    // "olvidé mi contraseña". Perder el mail no puede costar la instalación.
    if (alta.kind === 'created') {
      try {
        await issueAndSendPasswordResetEmail({
          userId: alta.userId,
          email: alta.email,
          name: info.name,
          origin,
        });
      } catch {
        // silencioso a propósito, ver arriba
      }
    }

    const destino = new URL('/login', origin);
    destino.searchParams.set('shopify', alta.kind === 'created' ? 'welcome' : 'reconnected');
    return limpiar(NextResponse.redirect(destino));
  }

  // ── Rama B, parte 2: guardar el token en el tenant ya validado ──────────
  // `tenantDashboard` quedó resuelto arriba; el compilador no lo sabe.
  if (!tenantDashboard) return fail('no_session');

  await db.tenant.update({
    where: { id: tenantDashboard.id },
    data: {
      shopifyStoreUrl: shop,
      shopifyToken: encrypt(accessToken),
    },
  });

  const webhookWarning = await registrarWebhooks(shop, accessToken, origin);

  return limpiar(NextResponse.redirect(new URL(`/settings?shopify=connected${webhookWarning}`, origin)));
}

/**
 * Registro de webhooks, best-effort. Si falla, la conexión igual sirve: el cron
 * levanta los pedidos, sólo que con hasta 15 minutos de demora en vez de al
 * instante. No vale la pena abortar una instalación por esto.
 */
async function registrarWebhooks(shop: string, accessToken: string, origin: string): Promise<string> {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;
    const r = await registerShopifyWebhooks(shop, accessToken, appUrl);
    return r.failed.length > 0 ? '&webhooks=partial' : '';
  } catch {
    return '&webhooks=failed';
  }
}
