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
} from '@/lib/shopify-oauth';
import { fetchShopInfo, provisionFromShopify } from '@/lib/shopify-provision';
import { issueAndSendPasswordResetEmail } from '@/lib/password-reset';
import { registerShopifyWebhooks } from '@/lib/shopify-register-webhooks';

export const dynamic = 'force-dynamic';

/**
 * GET /api/shopify/callback
 *
 * Paso 2 del "conectar con un botón". Shopify vuelve acá con `code`, `hmac`,
 * `shop`, `state` y `timestamp`.
 *
 * ORDEN DE LAS VALIDACIONES — importa, y por eso está escrito.
 * Cada chequeo corre ANTES de cualquier I/O que dependa del anterior:
 *   1. HMAC del query (autenticidad: esto lo mandó Shopify, no cualquiera).
 *   2. `state` contra la cookie (anti-CSRF: esta instalación la empezamos nosotros).
 *   3. Frescura del timestamp (anti-replay de un callback viejo interceptado).
 *   4. Dominio de tienda normalizado (anti open-redirect / SSRF).
 *   5. Sesión y propiedad del tenant (no conectar la tienda de otro).
 * Recién después se canjea el `code` por el token.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const fail = (motivo: string) => {
    // Las cookies se borran también al fallar: si no, un `state` ya expuesto
    // sigue siendo reusable hasta 10 minutos.
    const r = NextResponse.redirect(new URL(`/settings?shopify=${motivo}`, origin));
    r.cookies.delete(STATE_COOKIE);
    r.cookies.delete(TENANT_COOKIE);
    r.cookies.delete(FLOW_COOKIE);
    return r;
  };

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

  // 5. ¿De qué flujo viene? Decide todo lo que sigue.
  const esAppStore = req.cookies.get(FLOW_COOKIE)?.value === FLOW_APPSTORE;

  // Canje del code por el token de acceso offline. Va ANTES de la bifurcación
  // porque el flujo del App Store necesita el token para preguntarle a Shopify
  // de quién es la tienda: sin eso no sabríamos a nombre de quién crear la cuenta.
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
    return NextResponse.redirect(
      new URL(`/settings?shopify=missing_scopes&scopes=${encodeURIComponent(faltan.join(','))}`, origin),
    );
  }

  // ── Rama A: instalación desde el App Store ──────────────────────────────
  // No hay sesión ni cuenta. Se aprovisiona con lo que Shopify ya nos dio y se
  // le manda al comerciante un enlace para poner su contraseña.
  if (esAppStore) {
    const info = await fetchShopInfo(shop, accessToken);
    if (!info) return fail('shop_info_failed');

    const alta = await provisionFromShopify(info, accessToken);
    if (alta.kind === 'conflict') return fail('already_linked');

    await registrarWebhooks(shop, accessToken, origin);

    // Enlace para definir contraseña. Es best-effort a propósito: si el mail no
    // sale, la cuenta YA quedó creada y con la tienda conectada — el comerciante
    // puede entrar por "olvidé mi contraseña". Perder el mail no puede costar
    // la instalación.
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

    const destino = new URL('/login', origin);
    destino.searchParams.set('shopify', alta.kind === 'created' ? 'welcome' : 'reconnected');
    destino.searchParams.set('email', alta.email);
    const r = NextResponse.redirect(destino);
    r.cookies.delete(STATE_COOKIE);
    r.cookies.delete(TENANT_COOKIE);
    r.cookies.delete(FLOW_COOKIE);
    return r;
  }

  // ── Rama B: conectar desde el dashboard, con sesión ─────────────────────
  const user = await getAuthenticatedUser();
  const tenantId = req.cookies.get(TENANT_COOKIE)?.value;
  if (!user || !tenantId) return fail('no_session');

  const tenant = await db.tenant.findFirst({
    where: { id: tenantId, userId: user.userId },
    select: { id: true, shopifyStoreUrl: true },
  });
  if (!tenant) return fail('not_owner');

  // Reconectar puede cambiar el TOKEN, nunca el DOMINIO.
  if (tenant.shopifyStoreUrl && tenant.shopifyStoreUrl !== shop) {
    return fail('shop_mismatch');
  }

  // Se repite el chequeo de "ya vinculada" que hizo /install: entre uno y otro
  // pasaron hasta 10 minutos y otro tenant pudo haber tomado el mismo dominio.
  const tomadaPorOtro = await db.tenant.findFirst({
    where: { shopifyStoreUrl: shop, id: { not: tenant.id } },
    select: { id: true },
  });
  if (tomadaPorOtro) return fail('already_linked');

  await db.tenant.update({
    where: { id: tenant.id },
    data: {
      shopifyStoreUrl: shop,
      shopifyToken: encrypt(accessToken),
    },
  });

  // Los webhooks se registran con el token recién obtenido. Si falla, la
  // conexión igual sirve: el cron levanta los pedidos igual, sólo que con
  // hasta 15 minutos de demora en vez de al instante.
  const webhookWarning = await registrarWebhooks(shop, accessToken, origin);

  const res = NextResponse.redirect(new URL(`/settings?shopify=connected${webhookWarning}`, origin));
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(TENANT_COOKIE);
  res.cookies.delete(FLOW_COOKIE);
  return res;
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
