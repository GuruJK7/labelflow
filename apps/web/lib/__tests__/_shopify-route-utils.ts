import crypto from 'node:crypto';
import { NextRequest, type NextResponse } from 'next/server';

/** Firma un query string como lo hace Shopify en el callback / la App URL. */
export function signQuery(params: Record<string, string>, secret: string): string {
  const msg = Object.keys(params)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
}

export function makeRequest(
  path: string,
  query: Record<string, string>,
  cookies: Record<string, string> = {},
  origin = 'https://autoenvia.com',
): NextRequest {
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');
  return new NextRequest(url, { headers: cookie ? { cookie } : {} });
}

export function location(res: NextResponse): URL {
  const loc = res.headers.get('location');
  if (!loc) throw new Error('la respuesta no redirige');
  return new URL(loc);
}

/** true si la respuesta manda a borrar esa cookie (valor vacío). */
export function cookieDeleted(res: NextResponse, name: string): boolean {
  const c = res.cookies.get(name);
  return !!c && c.value === '';
}
