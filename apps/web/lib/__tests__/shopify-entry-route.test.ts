import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SHOPIFY_API_SECRET = 'secreto-de-test';
process.env.SHOPIFY_API_KEY = 'client-id-de-test';
process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';

const mocks = vi.hoisted(() => ({
  tenantFindFirst: vi.fn(),
  tenantUpdateMany: vi.fn(),
  vitalidad: vi.fn(),
  sesion: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: { tenant: { findFirst: mocks.tenantFindFirst, updateMany: mocks.tenantUpdateMany } },
}));
// El ping a Shopify se mockea: acá se prueba la DECISIÓN de /entry, la tabla
// de vitalidad tiene su propio test (shopify-token-liveness.test.ts).
vi.mock('@/lib/shopify-token-liveness', () => ({ vitalidadDelToken: mocks.vitalidad }));
vi.mock('@/lib/api-utils', () => ({ getAuthenticatedUser: mocks.sesion }));

import { GET } from '@/app/api/shopify/entry/route';
import { STATE_COOKIE, TENANT_COOKIE, FLOW_COOKIE, FLOW_APPSTORE } from '../shopify-oauth';
import { signQuery, makeRequest, location, cookieDeleted, fakeTenantFindFirst } from './_shopify-route-utils';

const SECRET = process.env.SHOPIFY_API_SECRET as string;
const SHOP = 'acme.myshopify.com';

function signedQuery(extra: Record<string, string> = {}) {
  const q: Record<string, string> = {
    shop: SHOP,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extra,
  };
  q.hmac = signQuery(q, SECRET);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenantFindFirst.mockResolvedValue(null);
  mocks.tenantUpdateMany.mockResolvedValue({ count: 1 });
  // Por default el token está vivo: es el caso de "abrir la app", que tiene
  // que seguir mandando al login sin reiniciar OAuth (D12).
  mocks.vitalidad.mockResolvedValue('viva');
  // Y sin sesión: el revisor abre la app desde el admin de Shopify en limpio.
  mocks.sesion.mockResolvedValue(null);
});

describe('/api/shopify/entry', () => {
  it('tienda nueva: arranca OAuth con STATE + FLOW=appstore y borra TENANT (H4)', async () => {
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery(), { [TENANT_COOKIE]: 'viejo' }));
    const loc = location(res);
    expect(loc.host).toBe(SHOP);
    expect(loc.pathname).toBe('/admin/oauth/authorize');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://autoenvia.com/api/shopify/callback');
    expect(res.cookies.get(STATE_COOKIE)?.value).toBe(loc.searchParams.get('state'));
    expect(res.cookies.get(FLOW_COOKIE)?.value).toBe(FLOW_APPSTORE);
    expect(cookieDeleted(res, TENANT_COOKIE)).toBe(true);
  });

  it('tienda ya vinculada con token vigente: NO reinicia OAuth, va a /login?shopify=open (H2)', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1' });
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery()));
    const loc = location(res);
    expect(loc.host).toBe('autoenvia.com');
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('open');
    expect(loc.searchParams.has('email')).toBe(false);
    expect(res.cookies.get(STATE_COOKIE)?.value ?? '').toBe('');
    expect(res.cookies.get(FLOW_COOKIE)?.value ?? '').toBe('');
    // El filtro pide token no nulo: una tienda desinstalada (token en null) sí reinstala.
    const where = mocks.tenantFindFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      shopifyStoreUrl: { equals: SHOP, mode: 'insensitive' },
      shopifyToken: { not: null },
    });
  });

  it('una fila guardada como "MiTienda.myshopify.com" (token manual) se encuentra con el dominio en minúsculas (D18)', async () => {
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 't-viejo', shopifyStoreUrl: 'MiTienda.myshopify.com', shopifyToken: 'enc' }]),
    );
    const q = signedQuery({ shop: 'mitienda.myshopify.com' });
    const res = await GET(makeRequest('/api/shopify/entry', q));
    // La encontró: es una apertura, no una instalación nueva. Sin esto,
    // arrancaba OAuth y el callback aprovisionaba una SEGUNDA cuenta para la
    // misma tienda, y el worker despachaba cada pedido dos veces.
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('open');
  });

  it('🔴 token guardado pero REVOCADO (el webhook app/uninstalled no llegó): reinicia OAuth y limpia el token', async () => {
    // El caso del revisor: desinstala, reinstala enseguida, y el token sigue
    // escrito en la base. Antes esto lo mandaba a /login?shopify=open para
    // siempre; la tienda quedaba instalada en Shopify y muerta acá.
    mocks.tenantFindFirst.mockResolvedValue({ id: 't-muerto', shopifyStoreUrl: SHOP, shopifyToken: 'enc-revocado' });
    mocks.vitalidad.mockResolvedValue('muerta');

    const res = await GET(makeRequest('/api/shopify/entry', signedQuery()));
    const loc = location(res);

    expect(loc.host).toBe(SHOP);
    expect(loc.pathname).toBe('/admin/oauth/authorize');
    expect(res.cookies.get(FLOW_COOKIE)?.value).toBe(FLOW_APPSTORE);
    // Y quedó como si el webhook hubiera llegado: token en null, nada más.
    expect(mocks.tenantUpdateMany).toHaveBeenCalledWith({
      where: { id: 't-muerto' },
      data: { shopifyToken: null },
    });
  });

  it('el ping se hace con la fila entera (id, dominio y token), que es lo que el resolvedor necesita', async () => {
    const fila = { id: 't1', shopifyStoreUrl: SHOP, shopifyToken: 'enc' };
    mocks.tenantFindFirst.mockResolvedValue(fila);
    await GET(makeRequest('/api/shopify/entry', signedQuery()));
    expect(mocks.vitalidad).toHaveBeenCalledWith(fila, SHOP);
    expect(mocks.tenantFindFirst.mock.calls[0][0].select).toEqual({ id: true, shopifyStoreUrl: true, shopifyToken: true });
  });

  it('Shopify no contestó (indeterminada): se conserva el comportamiento de hoy, al login, sin tocar el token', async () => {
    // Un hipo de Shopify no puede disparar OAuth en cada apertura (D12).
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', shopifyStoreUrl: SHOP, shopifyToken: 'enc' });
    mocks.vitalidad.mockResolvedValue('indeterminada');
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery()));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('open');
    expect(mocks.tenantUpdateMany).not.toHaveBeenCalled();
  });

  it('si limpiar el token falla, la reinstalación sigue igual: el callback lo pisa con el nuevo', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', shopifyStoreUrl: SHOP, shopifyToken: 'enc' });
    mocks.vitalidad.mockResolvedValue('muerta');
    mocks.tenantUpdateMany.mockRejectedValue(new Error('db caída'));
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery()));
    expect(location(res).pathname).toBe('/admin/oauth/authorize');
  });

  it('con sesión viva y token vivo: adentro (/dashboard), no al login otra vez', async () => {
    // Abrir la app desde el admin de Shopify estando logueado pedía usuario
    // y contraseña de nuevo: la cookie de sesión viaja (sameSite=lax) y nadie
    // la leía.
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', shopifyStoreUrl: SHOP, shopifyToken: 'enc' });
    mocks.sesion.mockResolvedValue({ userId: 'u1' });
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery()));
    expect(location(res).pathname).toBe('/dashboard');
    expect(res.cookies.get(STATE_COOKIE)?.value ?? '').toBe('');
  });

  it('con sesión viva pero token MUERTO: igual reinicia OAuth (la sesión no revive un token revocado)', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', shopifyStoreUrl: SHOP, shopifyToken: 'enc' });
    mocks.sesion.mockResolvedValue({ userId: 'u1' });
    mocks.vitalidad.mockResolvedValue('muerta');
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery()));
    expect(location(res).pathname).toBe('/admin/oauth/authorize');
  });

  it('si el chequeo de vitalidad TIRA, es una apertura normal (login), nunca un 500 ni un OAuth', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', shopifyStoreUrl: SHOP, shopifyToken: 'enc' });
    mocks.vitalidad.mockRejectedValue(new Error('boom'));
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery()));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('open');
    expect(mocks.tenantUpdateMany).not.toHaveBeenCalled();
  });

  it('con token en null la misma fila NO cuenta como conectada (desinstalada → reinstala)', async () => {
    mocks.tenantFindFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 't-viejo', shopifyStoreUrl: 'MiTienda.myshopify.com', shopifyToken: null }]),
    );
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery({ shop: 'mitienda.myshopify.com' })));
    expect(location(res).pathname).toBe('/admin/oauth/authorize');
  });

  it('HMAC inválido → /login?shopify=bad_hmac, sin tocar la base', async () => {
    const q = signedQuery();
    q.hmac = 'roto';
    const res = await GET(makeRequest('/api/shopify/entry', q));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('bad_hmac');
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
  });

  it('timestamp viejo → /login?shopify=stale', async () => {
    const res = await GET(makeRequest('/api/shopify/entry', signedQuery({ timestamp: '1000' })));
    expect(location(res).searchParams.get('shopify')).toBe('stale');
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
  });

  it('sin shop: a la home, sin error', async () => {
    const res = await GET(makeRequest('/api/shopify/entry', {}));
    expect(location(res).pathname).toBe('/');
  });
});
