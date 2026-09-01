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
} from '@/lib/shopify-oauth';
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

  // 5. Sesión y propiedad. La cookie dice a qué tenant atar; el usuario
  // logueado tiene que ser dueño de ese tenant. Las dos condiciones, no una.
  const user = await getAuthenticatedUser();
  const tenantId = req.cookies.get(TENANT_COOKIE)?.value;
  if (!user || !tenantId) return fail('no_session');

  const tenant = await db.tenant.findFirst({
    where: { id: tenantId, userId: user.userId },
    select: { id: true, shopifyStoreUrl: true },
  });
  if (!tenant) return fail('not_owner');

  // Reconectar puede cambiar el TOKEN, nunca el DOMINIO.
  //
  // Sin esto, alguien parado en la tienda A que escribe el dominio de una tienda
  // B y aprieta "Reconectar" deja al tenant A apuntando a B: el cliente A deja de
  // despachar y los pedidos de B salen con las credenciales DAC y el saldo de A,
  // en silencio y con la UI diciendo "Tienda conectada".
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
    return NextResponse.redirect(
      new URL(`/settings?shopify=missing_scopes&scopes=${encodeURIComponent(faltan.join(','))}`, origin),
    );
  }

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
  let webhookWarning = '';
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;
    const r = await registerShopifyWebhooks(shop, accessToken, appUrl);
    if (r.failed.length > 0) webhookWarning = '&webhooks=partial';
  } catch {
    webhookWarning = '&webhooks=failed';
  }

  const res = NextResponse.redirect(new URL(`/settings?shopify=connected${webhookWarning}`, origin));
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(TENANT_COOKIE);
  return res;
}
