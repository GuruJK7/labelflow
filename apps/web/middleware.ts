import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes - no auth needed
  const publicPaths = [
    '/login',
    '/signup',
    '/api/auth',
    '/api/webhooks',
    '/api/v1/mcp',
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

  // Dashboard routes require auth
  const dashboardPaths = [
    '/dashboard',
    '/orders',
    '/labels',
    '/logs',
    '/settings',
    '/onboarding',
  ];

  const isDashboardRoute = dashboardPaths.some((p) => pathname.startsWith(p));

  if (isDashboardRoute) {
    const token = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });

    if (!token) {
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
