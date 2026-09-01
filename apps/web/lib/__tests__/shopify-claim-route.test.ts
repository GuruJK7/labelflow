import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

process.env.ENCRYPTION_KEY = '44'.repeat(32);
process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';

const mocks = vi.hoisted(() => {
  const tx = {
    tenant: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  };
  return {
    tx,
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    userFindUnique: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    fetchShopInfo: vi.fn(),
    registerShopifyWebhooks: vi.fn(),
  };
});
vi.mock('@/lib/api-utils', () => ({ getAuthenticatedUser: mocks.getAuthenticatedUser }));
vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    tenant: mocks.tx.tenant,
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock('@/lib/shopify-provision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shopify-provision')>()),
  fetchShopInfo: mocks.fetchShopInfo,
}));
vi.mock('@/lib/shopify-register-webhooks', () => ({
  registerShopifyWebhooks: mocks.registerShopifyWebhooks,
}));

import { GET, POST } from '@/app/api/shopify/claim/route';
import { PENDING_INSTALL_COOKIE } from '../shopify-oauth';
import { sealPendingInstall } from '../shopify-pending-install';
import { decrypt } from '../encryption';
import { makeRequest, location, fakeTenantFindFirst } from './_shopify-route-utils';

const SHOP = 'acme.myshopify.com';

function pendingCookie(nowMs = Date.now()) {
  return { [PENDING_INSTALL_COOKIE]: sealPendingInstall({ shop: SHOP, token: 'shpat_pend' }, nowMs) };
}

const get = (cookies: Record<string, string> = {}) =>
  GET(makeRequest('/api/shopify/claim', {}, cookies));
type PostOpts = { form?: Record<string, string> | null; headers?: Record<string, string> };
/**
 * Por defecto manda el formulario que sirve el GET: `shop` = la tienda de la
 * cookie. `form: null` = POST sin cuerpo.
 */
const post = (cookies: Record<string, string> = {}, opts: PostOpts = {}) =>
  POST(
    makeRequest('/api/shopify/claim', {}, cookies, 'https://autoenvia.com', 'POST', {
      headers: opts.headers,
      form: opts.form === null ? undefined : (opts.form ?? { shop: SHOP }),
    }),
  );

/** La cookie pendiente tiene que salir borrada, con el mismo path con que se creó. */
function pendingDeleted(res: Awaited<ReturnType<typeof GET>>): boolean {
  const c = res.cookies.get(PENDING_INSTALL_COOKIE);
  return !!c && c.value === '' && c.path === '/api/shopify';
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u-sesion' });
  mocks.userFindUnique.mockResolvedValue({ email: 'dueno@acme.com' });
  mocks.fetchShopInfo.mockResolvedValue({ email: 'x@acme.com', name: 'Acme', domain: SHOP });
  mocks.registerShopifyWebhooks.mockResolvedValue({ registered: [], alreadyPresent: [], failed: [] });
  mocks.tx.tenant.findFirst.mockResolvedValue(null);
  mocks.tx.tenant.findUnique.mockResolvedValue(null);
  mocks.tx.tenant.create.mockResolvedValue({ id: 't-nuevo' });
});

describe('GET /api/shopify/claim — pregunta, no escribe (D19)', () => {
  it('sin sesión: vuelve al login con next, y conserva la cookie para poder volver', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    const res = await get(pendingCookie());
    // El GET no viene de un formulario: el 307 por defecto está bien acá.
    expect(res.status).toBe(307);
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('claim');
    expect(loc.searchParams.get('next')).toBe('/api/shopify/claim');
    expect(res.cookies.get(PENDING_INSTALL_COOKIE)).toBeUndefined();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('sin cookie: claim_expired, sin tocar la base', async () => {
    const res = await get();
    expect(location(res).pathname).toBe('/settings');
    expect(location(res).searchParams.get('shopify')).toBe('claim_expired');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('cookie que no descifra: claim_invalid y se borra', async () => {
    const res = await get({ [PENDING_INSTALL_COOKIE]: 'basura' });
    expect(location(res).searchParams.get('shopify')).toBe('claim_invalid');
    expect(pendingDeleted(res)).toBe(true);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('cookie con más de 600 s: claim_invalid y se borra', async () => {
    const res = await get(pendingCookie(Date.now() - 601_000));
    expect(location(res).searchParams.get('shopify')).toBe('claim_invalid');
    expect(pendingDeleted(res)).toBe(true);
  });

  it('con sesión y cookie válida: 200 HTML con la tienda y el email, formulario POST, y NO crea nada', async () => {
    const res = await get(pendingCookie());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain(SHOP);
    expect(html).toContain('dueno@acme.com');
    expect(html).toContain('<form method="post" action="/api/shopify/claim">');
    // El formulario nombra la tienda que muestra: el POST la exige igual a la cookie.
    expect(html).toContain(`<input type="hidden" name="shop" value="${SHOP}">`);
    expect(html).toContain('Vincular');
    // "Entrar con otra cuenta" → signout de NextAuth y de vuelta al login con next.
    expect(html).toContain(
      `href="/api/auth/signout?callbackUrl=${encodeURIComponent('/login?shopify=claim&next=/api/shopify/claim')}"`,
    );
    // Sin JS externo: es una página de una pregunta.
    expect(html).not.toMatch(/<script/i);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.tx.tenant.create).not.toHaveBeenCalled();
    expect(mocks.registerShopifyWebhooks).not.toHaveBeenCalled();
    // La cookie sigue viva: el POST la necesita.
    expect(res.cookies.get(PENDING_INSTALL_COOKIE)).toBeUndefined();
  });

  it('escapa el email: un email con <script> no sale crudo', async () => {
    mocks.userFindUnique.mockResolvedValue({ email: 'x<script>alert(1)</script>@acme.com' });
    const html = await (await get(pendingCookie())).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('x&lt;script&gt;alert(1)&lt;/script&gt;@acme.com');
  });

  it('sin email en la tabla, igual pregunta (dice "tu cuenta")', async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    const html = await (await get(pendingCookie())).text();
    expect(html).toContain('tu cuenta');
    expect(html).toContain(SHOP);
  });
});

describe('POST /api/shopify/claim — escribe, y redirige siempre con 303 (Post/Redirect/Get)', () => {
  it('sin sesión: al login con next, cookie intacta', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    const res = await post(pendingCookie());
    expect(res.status).toBe(303);
    const loc = location(res);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('shopify')).toBe('claim');
    expect(loc.searchParams.get('next')).toBe('/api/shopify/claim');
    expect(res.cookies.get(PENDING_INSTALL_COOKIE)).toBeUndefined();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('sin cookie (un POST cross-site llega así: la cookie es lax): claim_expired, nada escrito', async () => {
    const res = await post();
    expect(res.status).toBe(303);
    expect(location(res).searchParams.get('shopify')).toBe('claim_expired');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('cookie que no descifra: claim_invalid y se borra', async () => {
    const res = await post({ [PENDING_INSTALL_COOKIE]: 'basura' });
    expect(res.status).toBe(303);
    expect(location(res).searchParams.get('shopify')).toBe('claim_invalid');
    expect(pendingDeleted(res)).toBe(true);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('Origin de otro sitio con cookies válidas: claim_invalid antes de mirar sesión o base', async () => {
    const res = await post(pendingCookie(), { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(303);
    expect(location(res).searchParams.get('shopify')).toBe('claim_invalid');
    expect(pendingDeleted(res)).toBe(true);
    expect(mocks.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('Origin propio: sigue el camino normal', async () => {
    const res = await post(pendingCookie(), { headers: { origin: 'https://autoenvia.com' } });
    expect(location(res).searchParams.get('shopify')).toBe('connected');
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);
  });

  it('el formulario nombra OTRA tienda que la cookie (cookie sellada con B, form shop=A): claim_invalid, sin create', async () => {
    const cookieB = {
      [PENDING_INSTALL_COOKIE]: sealPendingInstall({ shop: 'b-store.myshopify.com', token: 'shpat_b' }),
    };
    const res = await post(cookieB, { form: { shop: SHOP } });
    expect(res.status).toBe(303);
    expect(location(res).searchParams.get('shopify')).toBe('claim_invalid');
    expect(pendingDeleted(res)).toBe(true);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.tx.tenant.create).not.toHaveBeenCalled();
    expect(mocks.registerShopifyWebhooks).not.toHaveBeenCalled();
  });

  it('POST sin formulario (sin `shop`): claim_invalid, sin create', async () => {
    const res = await post(pendingCookie(), { form: null });
    expect(location(res).searchParams.get('shopify')).toBe('claim_invalid');
    expect(pendingDeleted(res)).toBe(true);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('la tienda ya es de OTRO user (chequeo en la transacción): already_linked, no crea nada', async () => {
    mocks.tx.tenant.findFirst.mockResolvedValue({ id: 't-ajeno', userId: 'u-otro' });
    const res = await post(pendingCookie());
    expect(res.status).toBe(303);
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(mocks.tx.tenant.create).not.toHaveBeenCalled();
    expect(mocks.registerShopifyWebhooks).not.toHaveBeenCalled();
    expect(pendingDeleted(res)).toBe(true);
  });

  it('la tienda ya es de un tenant del MISMO user: already_yours con el handle, no crea nada', async () => {
    mocks.tx.tenant.findFirst.mockResolvedValue({ id: 't-mio', userId: 'u-sesion' });
    const res = await post(pendingCookie());
    expect(res.status).toBe(303);
    const loc = location(res);
    expect(loc.pathname).toBe('/settings');
    expect(loc.searchParams.get('shopify')).toBe('already_yours');
    expect(loc.searchParams.get('shop')).toBe('acme');
    expect(mocks.tx.tenant.create).not.toHaveBeenCalled();
    expect(mocks.registerShopifyWebhooks).not.toHaveBeenCalled();
    expect(pendingDeleted(res)).toBe(true);
  });

  it('busca la tienda sin distinguir mayúsculas: una fila "Acme.myshopify.com" cuenta como tomada', async () => {
    mocks.tx.tenant.findFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 't-viejo', shopifyStoreUrl: 'Acme.myshopify.com', userId: 'u-otro' }]),
    );
    const res = await post(pendingCookie());
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(mocks.tx.tenant.create).not.toHaveBeenCalled();
    expect(mocks.tx.tenant.findFirst.mock.calls[0][0].where).toEqual({
      shopifyStoreUrl: { equals: SHOP, mode: 'insensitive' },
    });
  });

  it('carrera perdida (P2002): already_linked', async () => {
    mocks.tx.tenant.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const res = await post(pendingCookie());
    expect(res.status).toBe(303);
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(pendingDeleted(res)).toBe(true);
  });

  it('error desconocido cuyo message trae el token y la cookie: claim_failed, y el log NO los contiene', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cookie = pendingCookie();
      const filtrado = `Invalid create() invocation:\n{ data: { shopifyToken: 'shpat_pend_XXX', cookie: '${cookie[PENDING_INSTALL_COOKIE]}' } }`;
      const err = new Error(filtrado);
      err.name = 'PrismaClientValidationError';
      mocks.tx.tenant.create.mockRejectedValue(err);

      const res = await post(cookie);
      expect(res.status).toBe(303);
      expect(location(res).searchParams.get('shopify')).toBe('claim_failed');
      expect(pendingDeleted(res)).toBe(true);

      expect(spy).toHaveBeenCalledTimes(1);
      const [tag, ctx] = spy.mock.calls[0];
      expect(tag).toBe('[shopify/claim]');
      expect(ctx).toEqual({
        shop: SHOP,
        userId: 'u-sesion',
        name: 'PrismaClientValidationError',
        code: undefined,
        message: 'Invalid create() invocation:',
      });
      const volcado = JSON.stringify(spy.mock.calls[0]);
      expect(volcado).not.toContain('shpat_pend');
      expect(volcado).not.toContain(cookie[PENDING_INSTALL_COOKIE]);
    } finally {
      spy.mockRestore();
    }
  });

  it('error desconocido de una sola línea larga: se recorta a 200 chars', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.tx.tenant.create.mockRejectedValue(new Error('x'.repeat(500)));
      await post(pendingCookie());
      const ctx = spy.mock.calls[0][1] as { message: string; name: string };
      expect(ctx.message).toHaveLength(200);
      expect(ctx.name).toBe('Error');
    } finally {
      spy.mockRestore();
    }
  });

  it('KnownRequestError de Prisma (P-xxxx): se loguea name, code y el message entero', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.tx.tenant.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Can't reach database server at `db:5432`\nPlease make sure it is running.", {
          code: 'P1001',
          clientVersion: 'test',
        }),
      );
      const res = await post(pendingCookie());
      expect(location(res).searchParams.get('shopify')).toBe('claim_failed');
      expect(spy.mock.calls[0][1]).toEqual({
        shop: SHOP,
        userId: 'u-sesion',
        name: 'PrismaClientKnownRequestError',
        code: 'P1001',
        message: "Can't reach database server at `db:5432`\nPlease make sure it is running.",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('dos reclamos seguidos con la misma cookie: el segundo da already_yours y NO vuelve a crear', async () => {
    const cookie = pendingCookie();
    const primera = await post(cookie);
    expect(location(primera).searchParams.get('shopify')).toBe('connected');
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);

    // La cookie se borró en la respuesta, pero un navegador viejo (o una
    // pestaña abierta antes) puede volver a presentarla: la tienda ya tiene
    // dueño (él mismo) y la transacción lo ve.
    mocks.tx.tenant.findFirst.mockResolvedValue({ id: 't-nuevo', userId: 'u-sesion' });
    const segunda = await post(cookie);
    expect(location(segunda).searchParams.get('shopify')).toBe('already_yours');
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(mocks.registerShopifyWebhooks).toHaveBeenCalledTimes(1);
    expect(pendingDeleted(segunda)).toBe(true);
  });

  it('el user B con una cookie sellada en la instalación de A (ya reclamada por A): already_linked, sin create', async () => {
    const cookie = pendingCookie();
    await post(cookie);
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(mocks.tx.tenant.create.mock.calls[0][0].data.userId).toBe('u-sesion');

    // B se loguea en su cuenta y presenta la misma cookie. La tienda ya es de
    // A: B no se la lleva ni se le crea nada.
    mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u-otro' });
    mocks.tx.tenant.findFirst.mockResolvedValue({ id: 't-nuevo', userId: 'u-sesion' });
    const res = await post(cookie);
    expect(location(res).searchParams.get('shopify')).toBe('already_linked');
    expect(mocks.tx.tenant.create).toHaveBeenCalledTimes(1);
    expect(pendingDeleted(res)).toBe(true);
  });

  it('camino feliz: crea el tenant bajo el user de la SESIÓN, registra webhooks, borra la cookie', async () => {
    const res = await post(pendingCookie());
    expect(res.status).toBe(303);
    const loc = location(res);
    expect(loc.pathname).toBe('/settings');
    expect(loc.searchParams.get('shopify')).toBe('connected');

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    const data = mocks.tx.tenant.create.mock.calls[0][0].data;
    expect(data.userId).toBe('u-sesion');
    expect(data.slug).toBe('shop-acme');
    expect(data.name).toBe('Acme');
    expect(data.shopifyStoreUrl).toBe(SHOP);
    expect(decrypt(data.shopifyToken)).toBe('shpat_pend');
    expect(data.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(data.referralCode).toMatch(/^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/);
    expect(data.tosAcceptedAt).toBeUndefined();
    // El bonus de bienvenida es por usuario, no por tienda: sin este 0
    // explícito el schema regala 10 envíos por cada tienda reclamada.
    expect(data.shipmentCredits).toBe(0);

    // El tenant reclamado no queda activo: el banner de /settings tiene que
    // poder nombrar la tienda. Va el handle, nunca el token ni el email.
    expect(loc.searchParams.get('shop')).toBe('acme');
    expect(loc.search).not.toContain('shpat');

    expect(mocks.registerShopifyWebhooks).toHaveBeenCalledWith(SHOP, 'shpat_pend', 'https://autoenvia.com');
    expect(pendingDeleted(res)).toBe(true);
  });

  it('si shop.json no contesta, igual reclama con el handle como nombre', async () => {
    mocks.fetchShopInfo.mockResolvedValue(null);
    const res = await post(pendingCookie());
    expect(location(res).searchParams.get('shopify')).toBe('connected');
    expect(mocks.tx.tenant.create.mock.calls[0][0].data.name).toBe('acme');
  });

  it('webhooks parciales no frenan el reclamo, avisan en la query', async () => {
    mocks.registerShopifyWebhooks.mockResolvedValue({
      registered: [], alreadyPresent: [], failed: [{ topic: 'orders/paid', status: 500, body: '' }],
    });
    const res = await post(pendingCookie());
    expect(location(res).searchParams.get('webhooks')).toBe('partial');
  });
});
