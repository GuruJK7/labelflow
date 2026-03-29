import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes - no auth needed
  const publicPaths = [
    '/login',
    '/signup',
    '/onboarding',
    '/terminos',
    '/privacidad',
    '/api/auth',
    '/api/webhooks',
    '/api/v1/mcp', // MCP uses its own Bearer token auth
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

  // All protected routes (dashboard + API)
  const protectedPaths = [
    '/dashboard',
    '/orders',
    '/labels',
    '/logs',
    '/settings',
    '/ads',
    '/api/v1',
    '/api/ads',
    '/api/stripe',
    '/api/mercadopago',
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
