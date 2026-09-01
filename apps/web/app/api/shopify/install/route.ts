import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenant } from '@/lib/api-utils';
import { db } from '@/lib/db';
import {
  normalizeShopDomain,
  buildAuthorizeUrl,
  generateState,
  callbackUrl,
  STATE_COOKIE,
  TENANT_COOKIE,
  FLOW_COOKIE,
  STATE_TTL_SECONDS,
} from '@/lib/shopify-oauth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/shopify/install?shop=acme.myshopify.com
 *
 * Paso 1 del "conectar con un botón". Reemplaza al tutorial donde el
 * comerciante tenía que crear su propia custom app y pegar el Admin API token
 * a mano (`/tutorial/shopify-token`).
 *
 * Requiere sesión: la conexión se ata a la tienda ACTIVA del usuario. El
 * tenant viaja en una cookie firmada por el propio navegador y se vuelve a
 * validar en el callback contra el usuario logueado, para que nadie pueda
 * conectar una tienda de Shopify al tenant de otro.
 *
 * El `state` es un nonce anti-CSRF: sin él, un atacante puede hacerle completar
 * a un comerciante logueado una instalación contra la tienda del atacante.
 */
export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) {
    // Sin sesión no sabemos a qué tienda atar la conexión. Mandamos a login y
    // volvemos acá con el shop preservado.
    const back = `/api/shopify/install?shop=${encodeURIComponent(req.nextUrl.searchParams.get('shop') ?? '')}`;
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(back)}`, req.nextUrl.origin));
  }

  const clientId = process.env.SHOPIFY_API_KEY;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !process.env.SHOPIFY_API_SECRET || !appUrl) {
    // Fail-closed y con un mensaje que dice exactamente qué falta, porque el
    // modo de falla silencioso de esta integración es carísimo de diagnosticar.
    return NextResponse.redirect(
      new URL('/settings?shopify=misconfigured', req.nextUrl.origin),
    );
  }

  const shop = normalizeShopDomain(req.nextUrl.searchParams.get('shop'));
  if (!shop) {
    return NextResponse.redirect(new URL('/settings?shopify=bad_shop', req.nextUrl.origin));
  }

  // Si esa tienda ya está conectada a OTRO tenant, frenamos acá. Sin este
  // chequeo, dos cuentas podrían apuntar a la misma tienda de Shopify y el
  // worker despacharía los mismos pedidos dos veces.
  const yaConectada = await db.tenant.findFirst({
    where: { shopifyStoreUrl: shop, id: { not: auth.tenantId } },
    select: { id: true },
  });
  if (yaConectada) {
    return NextResponse.redirect(new URL('/settings?shopify=already_linked', req.nextUrl.origin));
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
  res.cookies.set(TENANT_COOKIE, auth.tenantId, cookieOpts);
  // Si el comerciante apretó "Instalar" en el App Store hace un rato y lo
  // abandonó, la cookie de flujo sigue viva 10 minutos. Sin borrarla acá, el
  // callback tomaría ESTA conexión como una instalación del App Store,
  // ignoraría el tenant elegido y aprovisionaría por el email de la tienda.
  res.cookies.delete(FLOW_COOKIE);
  return res;
}
