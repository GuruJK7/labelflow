import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  normalizeShopDomain,
  buildAuthorizeUrl,
  verifyOAuthHmac,
  generateState,
  callbackUrl,
  STATE_COOKIE,
  TENANT_COOKIE,
  FLOW_COOKIE,
  FLOW_APPSTORE,
  STATE_TTL_SECONDS,
} from '@/lib/shopify-oauth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/shopify/entry — punto de entrada de una instalación iniciada por Shopify.
 *
 * POR QUÉ EXISTE, Y EN QUÉ SE DIFERENCIA DE /api/shopify/install
 * -------------------------------------------------------------
 * Son dos flujos distintos que terminan en el mismo lugar:
 *
 *   /install → el comerciante YA es cliente nuestro. Está logueado en su
 *              dashboard, aprieta "Conectar con Shopify" y elegimos a qué tenant
 *              suyo atar la tienda. Exige sesión, y está bien que la exija.
 *
 *   /entry   → alguien que no nos conoce aprieta "Instalar" en el App Store.
 *              Shopify le pega a la App URL con ?shop=&hmac=&timestamp= y espera
 *              que arranquemos OAuth INMEDIATAMENTE. No hay sesión, no hay cuenta,
 *              no hay nada. Pedir login acá rompe la instalación: el comerciante
 *              cae en una pantalla de "iniciá sesión" de un producto que todavía
 *              no contrató, y se va.
 *
 * Shopify verifica esto explícitamente: es la comprobación automática
 * "Inicia la autenticación inmediatamente después de la instalación".
 *
 * NO ES SÓLO INSTALAR: ES CADA APERTURA (D12)
 * -------------------------------------------
 * Shopify carga la App URL cada vez que el comerciante abre la app desde su
 * admin, no sólo al instalar. Si cada apertura reiniciara OAuth, cada apertura
 * terminaría en el callback aprovisionando "de nuevo" y mandando otro mail.
 * Por eso, si la tienda ya está conectada (dominio vinculado y token vigente),
 * acá no se reinicia nada: se manda al comerciante directo al login.
 *
 * SEGURIDAD
 * ---------
 * `shop` viene de un request sin autenticar, así que antes de redirigir a ningún
 * lado se verifica el HMAC de Shopify sobre el query, la frescura del timestamp
 * y la forma del dominio. Sin las tres, esto sería un open redirect con nuestra
 * marca encima. Los errores van a /login?shopify=<motivo> (pública, muestra el
 * mensaje); nunca a /settings, que rebota sin sesión y pierde el motivo.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const params = req.nextUrl.searchParams;
  const fail = (motivo: string) => NextResponse.redirect(new URL(`/login?shopify=${motivo}`, origin));

  const clientId = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;

  // Sin credenciales no se puede ni empezar. Fail-closed y visible.
  if (!clientId || !secret) return fail('misconfigured');

  const shop = normalizeShopDomain(params.get('shop'));
  if (!shop) {
    // Sin `shop` no es una instalación: es alguien entrando a la URL a mano.
    // Lo mandamos a la home en vez de mostrarle un error que no entiende.
    return NextResponse.redirect(new URL('/', origin));
  }

  // 1. Autenticidad: esto lo mandó Shopify, no cualquiera.
  if (!verifyOAuthHmac(params, secret)) return fail('bad_hmac');

  // 2. Frescura: un enlace de instalación viejo, interceptado, no sirve.
  const ts = Number(params.get('timestamp'));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return fail('stale');

  // 3. ¿Ya está conectada? Entonces esto es una apertura, no una instalación.
  const yaConectada = await db.tenant.findFirst({
    where: { shopifyStoreUrl: shop, shopifyToken: { not: null } },
    select: { id: true },
  });
  if (yaConectada) {
    const r = NextResponse.redirect(new URL('/login?shopify=open', origin));
    r.cookies.delete(STATE_COOKIE);
    r.cookies.delete(FLOW_COOKIE);
    r.cookies.delete(TENANT_COOKIE);
    return r;
  }

  const state = generateState();
  const url = buildAuthorizeUrl({
    shop,
    clientId,
    redirectUri: callbackUrl(appUrl),
    state,
  });

  const res = NextResponse.redirect(url);
  const cookieOpts = {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: STATE_TTL_SECONDS,
  };
  res.cookies.set(STATE_COOKIE, state, cookieOpts);
  // Marca que este OAuth nació en el App Store: el callback tiene que
  // aprovisionar cuenta en vez de exigir sesión.
  res.cookies.set(FLOW_COOKIE, FLOW_APPSTORE, cookieOpts);
  // Un "Conectar" del dashboard abandonado no puede contaminar esta
  // instalación: el callback rechaza FLOW=appstore + TENANT a la vez.
  res.cookies.delete(TENANT_COOKIE);
  return res;
}
