import { NextRequest, NextResponse } from 'next/server';
import {
  normalizeShopDomain,
  buildAuthorizeUrl,
  verifyOAuthHmac,
  generateState,
  callbackUrl,
  STATE_COOKIE,
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
 * SEGURIDAD
 * ---------
 * `shop` viene de un request sin autenticar, así que antes de redirigir a ningún
 * lado se verifica el HMAC de Shopify sobre el query, la frescura del timestamp
 * y la forma del dominio. Sin las tres, esto sería un open redirect con nuestra
 * marca encima.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const params = req.nextUrl.searchParams;

  const clientId = process.env.SHOPIFY_API_KEY;
  const secret = process.env.SHOPIFY_API_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;

  // Sin credenciales no se puede ni empezar. Fail-closed y visible.
  if (!clientId || !secret) {
    return NextResponse.redirect(new URL('/?shopify=misconfigured', origin));
  }

  const shop = normalizeShopDomain(params.get('shop'));
  if (!shop) {
    // Sin `shop` no es una instalación: es alguien entrando a la URL a mano.
    // Lo mandamos a la home en vez de mostrarle un error que no entiende.
    return NextResponse.redirect(new URL('/', origin));
  }

  // 1. Autenticidad: esto lo mandó Shopify, no cualquiera.
  if (!verifyOAuthHmac(params, secret)) {
    return NextResponse.redirect(new URL('/?shopify=bad_hmac', origin));
  }

  // 2. Frescura: un enlace de instalación viejo, interceptado, no sirve.
  const ts = Number(params.get('timestamp'));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return NextResponse.redirect(new URL('/?shopify=stale', origin));
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
  return res;
}
