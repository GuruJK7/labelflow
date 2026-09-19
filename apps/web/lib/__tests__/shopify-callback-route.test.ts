import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.ENCRYPTION_KEY = '33'.repeat(32);
process.env.SHOPIFY_API_SECRET = 'secreto-de-test';
process.env.SHOPIFY_API_KEY = 'client-id-de-test';
process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  fetchShopInfo: vi.fn(),
  provisionFromShopify: vi.fn(),
  issueAndSendPasswordResetEmail: vi.fn(),
  issuePasswordResetToken: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  registerShopifyWebhooks: vi.fn(),
}));

vi.mock('@/lib/api-utils', () => ({ getAuthenticatedUser: mocks.getAuthenticatedUser }));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { findFirst: mocks.tenantFindFirst, update: mocks.tenantUpdate },
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock('@/lib/shopify-provision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shopify-provision')>()),
  fetchShopInfo: mocks.fetchShopInfo,
  provisionFromShopify: mocks.provisionFromShopify,
}));
vi.mock('@/lib/password-reset', () => ({
  issueAndSendPasswordResetEmail: mocks.issueAndSendPasswordResetEmail,
  issuePasswordResetToken: mocks.issuePasswordResetToken,
  sendPasswordResetEmail: mocks.sendPasswordResetEmail,
}));
vi.mock('@/lib/shopify-register-webhooks', () => ({
  registerShopifyWebhooks: mocks.registerShopifyWebhooks,
}));

import { GET } from '@/app/api/shopify/callback/route';
import {
  STATE_COOKIE,
  TENANT_COOKIE,
  FLOW_COOKIE,
  FLOW_APPSTORE,
  NEXT_COOKIE,
  PENDING_INSTALL_COOKIE,
  SCOPES_PARAM,
} from '../shopify-oauth';
import { openPendingInstall } from '../shopify-pending-install';
import { decrypt } from '../encryption';
import { signQuery, makeRequest, location, cookieDeleted } from './_shopify-route-utils';

const SECRET = process.env.SHOPIFY_API_SECRET as string;
const SHOP = 'acme.myshopify.com';
const STATE = 'state-de-test-0123456789abcdef';
/** Token de elegir contraseña que emite el callback (texto plano, un solo uso). */
const TOKEN = 'reset-plano-0123456789abcdefABCDEF';

function signedQuery(extra: Record<string, string> = {}) {
  const q: Record<string, string> = {
    code: 'code-123',
    shop: SHOP,
    state: STATE,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extra,
  };
  q.hmac = signQuery(q, SECRET);
  return q;
}

const appStoreCookies = { [STATE_COOKIE]: STATE, [FLOW_COOKIE]: FLOW_APPSTORE };
const dashboardCookies = { [STATE_COOKIE]: STATE, [TENANT_COOKIE]: 'tenant-1' };

const fetchMock = vi.fn();

function exchangeOk() {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/admin/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'shpat_nuevo', scope: SCOPES_PARAM }), { status: 200 });
    }
    throw new Error(`fetch inesperado: ${url}`);
  });
}

function exchangeCalls() {
  return fetchMock.mock.calls.filter(([u]) => String(u).includes('/admin/oauth/access_token')).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  exchangeOk();
  mocks.registerShopifyWebhooks.mockResolvedValue({ registered: [], alreadyPresent: [], failed: [] });
  mocks.fetchShopInfo.mockResolvedValue({ email: 'dueno@acme.com', name: 'Acme', domain: SHOP });
  mocks.issueAndSendPasswordResetEmail.mockResolvedValue({ issued: true, send: null });
  mocks.issuePasswordResetToken.mockResolvedValue(TOKEN);
  mocks.sendPasswordResetEmail.mockResolvedValue({ ok: true });
  // Por default el usuario existente YA tiene contraseña: reinstalar no le
  // manda nada. El caso sin contraseña tiene su propio test.
  mocks.userFindUnique.mockResolvedValue({ passwordHash: '$2b$hash' });
});

describe('callback — rama B (dashboard): los permisos van ANTES del canje (H3)', () => {
  it('sin sesión: no_session y el code NO se canjea', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), dashboardCookies));
    const loc = location(res);
    expect(loc.pathname).toBe('/settings');
    expect(loc.searchParams.get('shopify')).toBe('no_session');
    expect(exchangeCalls()).toBe(0);
    expect(cookieDeleted(res, STATE_COOKIE)).toBe(true);
  });

  it('no es dueño del tenant: not_owner sin canjear', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst.mockResolvedValueOnce(null);
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), dashboardCookies));
    expect(location(res).searchParams.get('shopify')).toBe('not_owner');
    expect(exchangeCalls()).toBe(0);
  });

  it('el tenant ya apunta a otra tienda: shop_mismatch sin canjear', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst.mockResolvedValueOnce({ id: 'tenant-1', shopifyStoreUrl: 'otra.myshopify.com' });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), dashboardCookies));
    expect(location(res).searchParams.get('shopify')).toBe('shop_mismatch');
    expect(exchangeCalls()).toBe(0);
  });

  it('la tienda ya es de otro tenant: already_linked sin canjear', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst
      .mockResolvedValueOnce({ id: 'tenant-1', shopifyStoreUrl: null })
      .mockResolvedValueOnce({ id: 'tenant-ajeno' });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), dashboardCookies));
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(exchangeCalls()).toBe(0);
    // El chequeo de "tomada por otro" no distingue mayúsculas (D18).
    expect(mocks.tenantFindFirst.mock.calls[1][0].where).toEqual({
      shopifyStoreUrl: { equals: SHOP, mode: 'insensitive' },
      id: { not: 'tenant-1' },
    });
  });

  it('Reconectar un tenant guardado como "Acme.myshopify.com" con acme.myshopify.com NO es shop_mismatch (D18)', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst
      .mockResolvedValueOnce({ id: 'tenant-1', shopifyStoreUrl: 'Acme.myshopify.com' })
      .mockResolvedValueOnce(null);
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), dashboardCookies));
    // Reconectar es el camino de migración de los tokens manuales (D16): si
    // el dominio viejo con mayúsculas se tomara como "otra tienda", esos
    // clientes no podrían migrar nunca.
    expect(location(res).searchParams.get('shopify')).toBe('connected');
    expect(exchangeCalls()).toBe(1);
    // Y al guardar, el dominio queda normalizado en minúsculas.
    expect(mocks.tenantUpdate.mock.calls[0][0].data.shopifyStoreUrl).toBe(SHOP);
  });

  it('camino feliz: canjea, guarda el token cifrado en el tenant elegido y va a /settings', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst
      .mockResolvedValueOnce({ id: 'tenant-1', shopifyStoreUrl: null })
      .mockResolvedValueOnce(null);
    mocks.tenantUpdate.mockResolvedValue({});
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), dashboardCookies));
    const loc = location(res);
    expect(loc.pathname).toBe('/settings');
    expect(loc.searchParams.get('shopify')).toBe('connected');
    expect(exchangeCalls()).toBe(1);
    const upd = mocks.tenantUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'tenant-1' });
    expect(upd.data.shopifyStoreUrl).toBe(SHOP);
    expect(upd.data.shopifyToken).not.toBe('shpat_nuevo');
    expect(mocks.provisionFromShopify).not.toHaveBeenCalled();
    expect(mocks.issueAndSendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe('callback — anti-CSRF: la cookie STATE tiene que coincidir con el param', () => {
  it('rama dashboard: STATE distinto → bad_state, sin canjear ni mirar la sesión', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    const res = await GET(
      makeRequest('/api/shopify/callback', signedQuery(), { ...dashboardCookies, [STATE_COOKIE]: 'otro-state' }),
    );
    const loc = location(res);
    expect(loc.pathname).toBe('/settings');
    expect(loc.searchParams.get('shopify')).toBe('bad_state');
    expect(exchangeCalls()).toBe(0);
    expect(mocks.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
    expect(cookieDeleted(res, STATE_COOKIE)).toBe(true);
  });

  it('rama App Store: STATE distinto → /login?shopify=bad_state, sin canjear ni aprovisionar', async () => {
    const res = await GET(
      makeRequest('/api/shopify/callback', signedQuery(), { ...appStoreCookies, [STATE_COOKIE]: 'otro-state' }),
    );
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('bad_state');
    expect(exchangeCalls()).toBe(0);
    expect(mocks.fetchShopInfo).not.toHaveBeenCalled();
    expect(mocks.provisionFromShopify).not.toHaveBeenCalled();
    expect(res.cookies.get(PENDING_INSTALL_COOKIE)).toBeUndefined();
    expect(cookieDeleted(res, STATE_COOKIE)).toBe(true);
    expect(cookieDeleted(res, FLOW_COOKIE)).toBe(true);
  });
});

describe('callback — coherencia de cookies (H4)', () => {
  it('FLOW=appstore y TENANT a la vez → bad_flow, sin canjear ni aprovisionar', async () => {
    const res = await GET(
      makeRequest('/api/shopify/callback', signedQuery(), { ...appStoreCookies, [TENANT_COOKIE]: 'tenant-1' }),
    );
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('bad_flow');
    expect(exchangeCalls()).toBe(0);
    expect(mocks.provisionFromShopify).not.toHaveBeenCalled();
    expect(cookieDeleted(res, FLOW_COOKIE)).toBe(true);
    expect(cookieDeleted(res, TENANT_COOKIE)).toBe(true);
  });
});

describe('callback — rama A (App Store): destinos públicos, sin email en la query (H5)', () => {
  it('cualquier fallo aterriza en /login, nunca en /settings', async () => {
    const q = signedQuery();
    q.hmac = 'hmac-roto';
    const res = await GET(makeRequest('/api/shopify/callback', q, appStoreCookies));
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('bad_hmac');
  });

  it('faltan scopes → /login?shopify=missing_scopes', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'shpat_x', scope: 'read_orders' }), { status: 200 }),
    );
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('missing_scopes');
    expect(cookieDeleted(res, STATE_COOKIE)).toBe(true);
  });

  it('shop.json falla → /login?shopify=shop_info_failed', async () => {
    mocks.fetchShopInfo.mockResolvedValueOnce(null);
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('shop_info_failed');
  });

  it("🔴 'created' → va DIRECTO a elegir contraseña con el token, y el mail es la copia", async () => {
    // Antes: /login?shopify=welcome y la ÚNICA llave era un mail al email de
    // contacto de la tienda. El revisor del App Store no lo miraba, entraba
    // con las credenciales del listing a OTRA cuenta y no veía sus pedidos.
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'created', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    const loc = location(res);
    expect(loc.pathname).toBe(`/reset-password/${TOKEN}`);
    expect(loc.searchParams.get('shopify')).toBe('welcome');
    expect(loc.searchParams.has('email')).toBe(false);
    expect(mocks.issuePasswordResetToken).toHaveBeenCalledWith({ userId: 'u1' });
    // El mail sale igual, con el MISMO token: la copia por si cierra la pestaña.
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendPasswordResetEmail.mock.calls[0][0]).toMatchObject({ email: 'dueno@acme.com', plaintext: TOKEN });
    expect(mocks.issueAndSendPasswordResetEmail).not.toHaveBeenCalled();
    expect(cookieDeleted(res, STATE_COOKIE)).toBe(true);
  });

  it("'created' y no se pudo emitir el token → camino viejo: /login?shopify=welcome + mail", async () => {
    mocks.issuePasswordResetToken.mockResolvedValue(null);
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'created', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('welcome');
    expect(mocks.issueAndSendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it("'created' y el mail falla → igual va a elegir contraseña: el navegador ya lleva el token", async () => {
    mocks.sendPasswordResetEmail.mockRejectedValue(new Error('resend caído'));
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'created', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    expect(location(res).pathname).toBe(`/reset-password/${TOKEN}`);
  });

  it("'existing' (reapertura/reinstalación) con contraseña NO manda mail: no invalida la que tiene (H2)", async () => {
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'existing', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('reconnected');
    expect(loc.searchParams.has('email')).toBe(false);
    expect(mocks.issueAndSendPasswordResetEmail).not.toHaveBeenCalled();
    expect(mocks.issuePasswordResetToken).not.toHaveBeenCalled();
  });

  it("🔴 'existing' de alguien que NUNCA eligió contraseña → directo a elegirla (y mail de copia)", async () => {
    // El revisor instala (llega el mail, dura 1 h), no lo usa, desinstala,
    // reinstala al otro día. Es 'existing'. Sin esto aterrizaba en /login con
    // «iniciá sesión para seguir» y nada con qué hacerlo.
    mocks.userFindUnique.mockResolvedValue({ passwordHash: null });
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'existing', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    const loc = location(res);
    expect(loc.pathname).toBe(`/reset-password/${TOKEN}`);
    expect(loc.searchParams.get('shopify')).toBe('reconnected');
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { passwordHash: true } });
    expect(mocks.issuePasswordResetToken).toHaveBeenCalledWith({ userId: 'u1' });
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it("'existing' con contraseña vigente: /login?shopify=reconnected y ningún token ni mail", async () => {
    mocks.userFindUnique.mockResolvedValue({ passwordHash: '$2b$vigente' });
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'existing', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('reconnected');
    expect(mocks.issuePasswordResetToken).not.toHaveBeenCalled();
    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(mocks.issueAndSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("si la base falla al mirar la contraseña, no se emite nada de más y la reinstalación sigue", async () => {
    mocks.userFindUnique.mockRejectedValue(new Error('db caída'));
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'existing', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('reconnected');
    expect(mocks.issuePasswordResetToken).not.toHaveBeenCalled();
    expect(mocks.issueAndSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("'created' nunca consulta la contraseña: la cuenta es nueva y el token va siempre", async () => {
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'created', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.issuePasswordResetToken).toHaveBeenCalledTimes(1);
  });

  it('apertura repetida: dos callbacks seguidos con la tienda ya existente no emiten ningún reset', async () => {
    mocks.provisionFromShopify.mockResolvedValue({
      kind: 'existing', userId: 'u1', tenantId: 't1', email: 'dueno@acme.com',
    });
    await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    expect(mocks.issueAndSendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("'conflict' → /login?shopify=already_linked, sin mail ni webhooks", async () => {
    mocks.provisionFromShopify.mockResolvedValue({ kind: 'conflict', reason: 'shop_taken' });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(mocks.issueAndSendPasswordResetEmail).not.toHaveBeenCalled();
    expect(mocks.registerShopifyWebhooks).not.toHaveBeenCalled();
  });

  it("'claim' → cookie cifrada de instalación pendiente y DIRECTO a /api/shopify/claim (H1)", async () => {
    mocks.provisionFromShopify.mockResolvedValue({ kind: 'claim', email: 'dueno@acme.com' });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    const loc = location(res);
    // Directo a /claim: si hay sesión reclama en el acto; si no, /claim es el
    // que manda a /login?shopify=claim&next=/api/shopify/claim (test en
    // shopify-claim-route). Acá no se pasa por el login a ciegas.
    expect(loc.pathname).toBe('/api/shopify/claim');
    expect(loc.search).toBe('');

    // Nada se escribió ni se mandó todavía: eso pasa recién en /claim.
    expect(mocks.issueAndSendPasswordResetEmail).not.toHaveBeenCalled();
    expect(mocks.registerShopifyWebhooks).not.toHaveBeenCalled();

    const cookie = res.cookies.get(PENDING_INSTALL_COOKIE);
    expect(cookie).toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('lax');
    expect(cookie!.path).toBe('/api/shopify');
    expect(cookie!.maxAge).toBe(600);
    expect(cookie!.value).not.toContain('shpat_nuevo');
    const abierta = openPendingInstall(cookie!.value);
    expect(abierta?.shop).toBe(SHOP);
    expect(abierta?.token).toBe('shpat_nuevo');

    // Las cookies del OAuth se limpian igual.
    expect(cookieDeleted(res, STATE_COOKIE)).toBe(true);
    expect(cookieDeleted(res, FLOW_COOKIE)).toBe(true);
  });
});

describe('callback — tokens offline expirables (D29)', () => {
  const EXPIRING = {
    access_token: 'shpat_nuevo',
    scope: SCOPES_PARAM,
    expires_in: 3600,
    refresh_token: 'shprt_nuevo',
    refresh_token_expires_in: 7776000,
  };

  function exchangeBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/admin/oauth/access_token'));
    if (!call) throw new Error('no hubo canje');
    return JSON.parse(String((call[1] as RequestInit).body));
  }

  it('el canje pide expiring: "1" y guarda el envelope entero cifrado (rama B)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(EXPIRING), { status: 200 }));
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst.mockResolvedValueOnce({ id: 'tenant-1', shopifyStoreUrl: null }).mockResolvedValueOnce(null);
    mocks.tenantUpdate.mockResolvedValue({});
    const antes = Date.now();
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), dashboardCookies));
    expect(location(res).searchParams.get('shopify')).toBe('connected');

    expect(exchangeBody()).toEqual({
      client_id: 'client-id-de-test',
      client_secret: 'secreto-de-test',
      code: 'code-123',
      expiring: '1',
    });

    const guardado = JSON.parse(decrypt(mocks.tenantUpdate.mock.calls[0][0].data.shopifyToken));
    expect(guardado.v).toBe(1);
    expect(guardado.access).toBe('shpat_nuevo');
    expect(guardado.refresh).toBe('shprt_nuevo');
    expect(guardado.exp).toBeGreaterThanOrEqual(antes + 3600 * 1000);
    expect(guardado.exp).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    expect(guardado.refreshExp).toBeGreaterThanOrEqual(antes + 7776000 * 1000);
    // Los webhooks se registran con el access, no con el envelope.
    expect(mocks.registerShopifyWebhooks.mock.calls[0][1]).toBe('shpat_nuevo');
  });

  it('si Shopify no devuelve refresh_token, el access se guarda pelado (legacy) y el canje igual pidió expiring', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst.mockResolvedValueOnce({ id: 'tenant-1', shopifyStoreUrl: null }).mockResolvedValueOnce(null);
    mocks.tenantUpdate.mockResolvedValue({});
    await GET(makeRequest('/api/shopify/callback', signedQuery(), dashboardCookies));
    expect(exchangeBody().expiring).toBe('1');
    expect(decrypt(mocks.tenantUpdate.mock.calls[0][0].data.shopifyToken)).toBe('shpat_nuevo');
  });

  it('rama A: provision recibe el envelope, shop info el access, y la cookie pendiente transporta el envelope entero', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(EXPIRING), { status: 200 }));
    mocks.provisionFromShopify.mockResolvedValue({ kind: 'claim', email: 'dueno@acme.com' });
    const res = await GET(makeRequest('/api/shopify/callback', signedQuery(), appStoreCookies));
    expect(location(res).pathname).toBe('/api/shopify/claim');

    expect(mocks.fetchShopInfo).toHaveBeenCalledWith(SHOP, 'shpat_nuevo');
    const [, credencial] = mocks.provisionFromShopify.mock.calls[0];
    const envelope = JSON.parse(credencial);
    expect(envelope).toMatchObject({ v: 1, access: 'shpat_nuevo', refresh: 'shprt_nuevo' });

    const cookie = res.cookies.get(PENDING_INSTALL_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    expect(cookie).not.toContain('shpat_');
    expect(cookie).not.toContain('shprt_');
    expect(openPendingInstall(cookie)?.token).toBe(credencial);
  });
});

describe('callback — rama B con cookie NEXT (D33: volver al wizard)', () => {
  it('cookie next=/onboarding → conecta y vuelve a /onboarding?shopify=connected, borrando la cookie', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst
      .mockResolvedValueOnce({ id: 'tenant-1', shopifyStoreUrl: null })
      .mockResolvedValueOnce(null);
    mocks.tenantUpdate.mockResolvedValue({});
    const res = await GET(
      makeRequest('/api/shopify/callback', signedQuery(), { ...dashboardCookies, [NEXT_COOKIE]: '/onboarding' }),
    );
    const loc = location(res);
    expect(loc.pathname).toBe('/onboarding');
    expect(loc.searchParams.get('shopify')).toBe('connected');
    expect(cookieDeleted(res, NEXT_COOKIE)).toBe(true);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
  });

  it('los errores de la rama B también vuelven al next', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    const res = await GET(
      makeRequest('/api/shopify/callback', signedQuery(), { ...dashboardCookies, [NEXT_COOKIE]: '/onboarding' }),
    );
    const loc = location(res);
    expect(loc.pathname).toBe('/onboarding');
    expect(loc.searchParams.get('shopify')).toBe('no_session');
    expect(exchangeCalls()).toBe(0);
  });

  it('cookie NEXT con una URL absoluta se ignora: vuelve a /settings', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
    mocks.tenantFindFirst
      .mockResolvedValueOnce({ id: 'tenant-1', shopifyStoreUrl: null })
      .mockResolvedValueOnce(null);
    mocks.tenantUpdate.mockResolvedValue({});
    const res = await GET(
      makeRequest('/api/shopify/callback', signedQuery(), { ...dashboardCookies, [NEXT_COOKIE]: 'https://evil.com' }),
    );
    expect(location(res).pathname).toBe('/settings');
  });

  it('rama App Store ignora la cookie NEXT: una cuenta nueva va a elegir contraseña, no a /onboarding', async () => {
    mocks.provisionFromShopify.mockResolvedValue({ kind: 'created', userId: 'u9', email: 'dueno@acme.com', tenantId: 't9' });
    const res = await GET(
      makeRequest('/api/shopify/callback', signedQuery(), { ...appStoreCookies, [NEXT_COOKIE]: '/onboarding' }),
    );
    expect(location(res).pathname).toBe(`/reset-password/${TOKEN}`);
  });

  it('rama App Store ignora la cookie NEXT: una cuenta con contraseña sigue en /login', async () => {
    mocks.provisionFromShopify.mockResolvedValue({ kind: 'existing', userId: 'u9', email: 'dueno@acme.com', tenantId: 't9' });
    const res = await GET(
      makeRequest('/api/shopify/callback', signedQuery(), { ...appStoreCookies, [NEXT_COOKIE]: '/onboarding' }),
    );
    expect(location(res).pathname).toBe('/login');
  });
});
