import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes - no auth needed
  const publicPaths = [
    '/login',
    '/signup',
    '/forgot-password',           // 2026-05-15 — password reset flow
    '/reset-password',            // 2026-05-15 — /reset-password/[token]
    '/pricing',                   // 2026-05-15 — public pricing page
    '/onboarding',
    // '/tutorial' — SACADO 2026-09-05 por el requisito 2.3.1 del App Store.
    // /tutorial/shopify-token enseña paso a paso a crearse una app privada y
    // copiar un Admin API token, que es justo el flujo que 2.3.1 prohíbe
    // ofrecer. Siendo ruta pública, un revisor la encuentra aunque la UI que la
    // linkeaba esté apagada. Deja de ser pública; el contenido no se borra
    // porque sigue sirviendo para soporte de los tenants viejos, que tienen
    // sesión.
    '/terminos',
    '/privacidad',
    '/cliente',                   // 2026-06-02 — tokenized client label portal
                                  // (/cliente/[token]); access is gated by the
                                  // token inside the page, not by a session.
    '/api/public',                // Token-gated public endpoints (client portal
                                  // PDF download). Auth is the portal token.
    '/api/auth',
    '/api/webhooks',
    '/api/health',                // 2026-05-15 — uptime probe
    '/api/v1/mcp', // MCP uses its own Bearer token auth
    '/api/v1/wms/export', // 2026-09-01 — export de la tanda al WMS (DEPO). Igual
                          // que /api/v1/mcp: se autentica con `Authorization:
                          // Bearer <Tenant.apiKey>` (o con la sesión, si el
                          // operador la abre en el navegador), y esa resolución
                          // pasa DENTRO del handler. Sin esta línea el prefijo
                          // '/api/v1' de protectedPaths rebota el Bearer con
                          // 401 antes de que el handler llegue a mirarlo.
    '/api/recover/subscription-webhook', // MercadoPago calls this — no session available
    '/api/referrals/track', // Pre-signup endpoint to set signed referral cookie
    '/_next',
    '/favicon.ico',
  ];

  if (publicPaths.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Landing page at root "/" - always public
  if (pathname === '/') {
    return NextResponse.next();
  }

  // All protected routes (dashboard + API). Defense-in-depth: aún si una
  // ruta nueva se olvida de llamar getAuthenticatedTenant(), el middleware
  // la rebota con 401 antes de tocar la DB.
  const protectedPaths = [
    '/tutorial',  // 2026-09-05 — requisito 2.3.1. /tutorial/shopify-token enseña
                  // a crearse una app privada y copiar un Admin API token. No
                  // alcanzaba con sacarlo de publicPaths: el middleware es una
                  // allowlist de PROTECCIÓN, así que lo que no está en ninguna
                  // de las dos listas queda accesible igual. Va acá para que
                  // exija sesión de verdad.
    '/dashboard',
    '/orders',
    '/labels',
    '/settings',
    '/ads',
    '/recover',
    '/api/v1',
    '/api/ads',
    '/api/admin', // Defense-in-depth: getAdminSession() inside handlers is the
                  // real gate, but a forgotten check on a future /api/admin/*
                  // sub-route would slip through without this prefix listed.
    '/api/mercadopago',
    '/api/recover',
    '/api/credit-packs',
    '/api/referrals',
  ];

  const isProtected = protectedPaths.some((p) => pathname.startsWith(p));

  if (isProtected) {
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });

    if (!token) {
      // API routes return 401 JSON, pages redirect to login
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
