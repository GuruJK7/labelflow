import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '88'.repeat(32);

/**
 * POST /api/v1/onboarding/test-dashboard — prueba la fuente "Dashboard con
 * Excel" con la MISMA llamada que hace el worker y recién ahí la guarda
 * prendida (D33). El token va sólo a la URL del usuario y se guarda cifrado.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantUpdate: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({ db: { tenant: { update: mocks.tenantUpdate } } }));

import { POST } from '@/app/api/v1/onboarding/test-dashboard/route';
import { decrypt } from '../encryption';

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: false, subscriptionStatus: 'INACTIVE',
  });
  mocks.tenantUpdate.mockResolvedValue({});
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify({ orders: [{ id: 'o1', address: 'x' }] }), { status: 200 }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function post(body: unknown) {
  return POST(
    new Request('https://autoenvia.com/api/v1/onboarding/test-dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
const OK = { dashboardUrl: 'https://autoenvia-dash.vercel.app/', dashboardToken: 'ae_0123456789' };

describe('POST /api/v1/onboarding/test-dashboard', () => {
  it('sin sesión → 401 sin llamar a nadie', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValueOnce(null);
    expect((await post(OK)).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prueba con la misma llamada del worker (Bearer, status=confirmed, limit=1) y guarda la fuente prendida con el token cifrado', async () => {
    const res = await post(OK);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ok: true, ordersSeen: 1 });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://autoenvia-dash.vercel.app/api/v1/orders?status=confirmed&limit=1');
    expect(init.headers.Authorization).toBe('Bearer ae_0123456789');
    const upd = mocks.tenantUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'tenant-1' });
    expect(upd.data.dashboardUrl).toBe('https://autoenvia-dash.vercel.app');
    expect(upd.data.dashboardSourceEnabled).toBe(true);
    expect(upd.data.dashboardToken).not.toBe('ae_0123456789');
    expect(decrypt(upd.data.dashboardToken)).toBe('ae_0123456789');
  });

  it.each([
    ['http://autoenvia-dash.vercel.app', 'http'],
    ['https://localhost:3000', 'localhost'],
    ['https://127.0.0.1', 'IP literal'],
    ['https://[::1]', 'IPv6'],
    ['no-es-una-url', 'no URL'],
  ])('rechaza %s (%s) → 400 sin llamar ni guardar', async (dashboardUrl) => {
    const res = await post({ dashboardUrl, dashboardToken: 'ae_0123456789' });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('token corto → 400', async () => {
    expect((await post({ ...OK, dashboardToken: 'abc' })).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('el dashboard responde 401 → 422 con el mensaje del token y NO guarda', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 401 }));
    const res = await post(OK);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/rechazó el token/);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('otro status → 422 nombrando el status', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
    const res = await post(OK);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/respondió 500/);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('timeout → 422 "tardó demasiado"', async () => {
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    fetchSpy.mockRejectedValueOnce(err);
    const res = await post(OK);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/tardó demasiado/);
  });

  it('respuesta 200 sin `orders` → igual conecta, ordersSeen null', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const res = await post(OK);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ok: true, ordersSeen: null });
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
  });
});
