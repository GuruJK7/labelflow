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
  method: 'GET' | 'POST' = 'GET',
): NextRequest {
  const url = new URL(path, origin);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');
  return new NextRequest(url, { method, headers: cookie ? { cookie } : {} });
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

export interface FakeTenantRow {
  id: string;
  shopifyStoreUrl: string | null;
  shopifyToken?: string | null;
  userId?: string;
  isActive?: boolean;
}

type StringFilter = string | { equals?: string; mode?: 'insensitive' | 'default' };

/**
 * `tenant.findFirst` de mentira que evalúa el `where` de verdad sobre una
 * tabla en memoria, con la semántica de Prisma que usan las rutas de Shopify
 * (`equals` + `mode: 'insensitive'`, `{ not: null }`, `{ not: id }`).
 *
 * Existe para que los tests de "un dominio guardado con mayúsculas se
 * encuentra igual" prueben la propiedad y no la forma del objeto: un
 * `toEqual` sobre el `where` pasa aunque el filtro no encuentre nada.
 * Cualquier clave que no se contemple acá tira, para que un `where` nuevo no
 * pase en silencio como "coincide".
 */
export function fakeTenantFindFirst(rows: FakeTenantRow[]) {
  return async (args: { where: Record<string, unknown> }): Promise<FakeTenantRow | null> => {
    const fila = rows.find((r) => coincide(r, args.where));
    return fila ?? null;
  };
}

/**
 * `tenant.updateMany` de mentira con el MISMO evaluador de `where` que
 * `fakeTenantFindFirst`: aplica `data` a las filas que coinciden y devuelve
 * `{ count }`. Muta las filas para que el test pueda mirar qué quedó tocado y
 * qué no.
 */
export function fakeTenantUpdateMany(rows: FakeTenantRow[]) {
  return async (args: {
    where: Record<string, unknown>;
    data: Partial<FakeTenantRow>;
  }): Promise<{ count: number }> => {
    const tocadas = rows.filter((r) => coincide(r, args.where));
    for (const r of tocadas) Object.assign(r, args.data);
    return { count: tocadas.length };
  };
}

function coincide(r: FakeTenantRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    switch (k) {
      case 'shopifyStoreUrl': {
        const f = v as StringFilter;
        if (r.shopifyStoreUrl == null) return false;
        if (typeof f === 'string') {
          if (r.shopifyStoreUrl !== f) return false;
        } else if (f.mode === 'insensitive') {
          if (r.shopifyStoreUrl.toLowerCase() !== (f.equals ?? '').toLowerCase()) return false;
        } else if (r.shopifyStoreUrl !== f.equals) {
          return false;
        }
        break;
      }
      case 'shopifyToken': {
        const f = v as { not?: null };
        if (f && 'not' in f && f.not === null && r.shopifyToken == null) return false;
        break;
      }
      case 'id': {
        const f = v as string | { not: string };
        if (typeof f === 'string' ? r.id !== f : r.id === f.not) return false;
        break;
      }
      case 'userId':
        if (r.userId !== v) return false;
        break;
      case 'isActive':
        if ((r.isActive ?? false) !== v) return false;
        break;
      default:
        throw new Error(`fakeTenantFindFirst: filtro no contemplado "${k}"`);
    }
  }
  return true;
}
