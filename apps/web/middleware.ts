export { default } from 'next-auth/middleware';

export const config = {
  matcher: [
    '/((?!login|signup|home|api/auth|api/webhooks|api/v1/mcp|_next/static|_next/image|favicon.ico).*)',
  ],
};
