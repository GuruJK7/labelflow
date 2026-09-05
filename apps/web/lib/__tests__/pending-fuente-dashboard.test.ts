import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '77'.repeat(32);

/**
 * `getUnfulfilledCount` para las tiendas de la fuente dashboard.
 *
 * POR QUÉ ESTO IMPORTA MÁS QUE UN NÚMERO EN PANTALLA. Las cuentas que opera el
 * depósito tienen el cron apagado a propósito (`operacion: 'manual'` en
 * `/api/provisioning/dac-tenant`), así que el ÚNICO disparo es el botón
 * "Ejecutar" del Centro de Control. Sin este contador, apretarlo es adivinar si
 * hay algo para despachar.
 *
 * Cada test usa un tenantId distinto: `getUnfulfilledCount` cachea 2 minutos en
 * un Map del proceso y los tests comparten el módulo.
 */
const mocks = vi.hoisted(() => ({ tenantFindUnique: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { tenant: { findUnique: mocks.tenantFindUnique } } }));
vi.mock('@/lib/shopify-access', () => ({ shopifyAccessForTenant: vi.fn(async () => null) }));

import { getUnfulfilledCount } from '../shopify-pending';
import { encrypt } from '../encryption';

const fetchSpy = vi.fn();

/** Tienda de la fuente dashboard: sin Shopify, con url y token. */
function tiendaDashboard(dashboardUrl: string) {
  return {
    id: 't',
    shopifyStoreUrl: null,
    shopifyToken: null,
    codEnabled: false,
    dashboardSourceEnabled: true,
    dashboardUrl,
    dashboardToken: encrypt('depo_token'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe('getUnfulfilledCount — fuente dashboard', () => {
  it('cuenta los pedidos que devuelve el dashboard, con la misma llamada que el worker', async () => {
    mocks.tenantFindUnique.mockResolvedValue(tiendaDashboard('https://depo-beige.vercel.app'));
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ orders: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), { status: 200 }),
    );

    const r = await getUnfulfilledCount('t-dash-ok');
    expect(r.count).toBe(3);
    expect(r.skipped).toBeUndefined();

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/orders');
    expect(url.searchParams.get('status')).toBe('confirmed');
    // El token viaja descifrado en el header, nunca en la query string.
    const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer depo_token');
    expect(url.search).not.toContain('depo_token');
  });

  it('una respuesta sin `orders` no inventa un cero', async () => {
    mocks.tenantFindUnique.mockResolvedValue(tiendaDashboard('https://depo-beige.vercel.app'));
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const r = await getUnfulfilledCount('t-dash-raro');
    // null = "no se pudo saber". Un 0 diría "no hay nada para despachar", que es
    // una afirmación que acá no tenemos con qué sostener.
    expect(r.count).toBeNull();
    expect(r.skipped).toBe('error');
  });

  it('un dashboard caído no rompe el panel', async () => {
    mocks.tenantFindUnique.mockResolvedValue(tiendaDashboard('https://depo-beige.vercel.app'));
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await getUnfulfilledCount('t-dash-caido');
    expect(r.count).toBeNull();
    expect(r.skipped).toBe('error');
  });

  // ── Defensa en profundidad sobre la URL ────────────────────────────────────
  // `provisioning/dac-tenant` acepta cualquier `http(s)://`, así que la guarda
  // vive en el punto de la llamada: ningún camino de escritura futuro puede
  // convertir esto en una sonda contra la red interna de Vercel.
  it.each([
    ['http (sin TLS)', 'http://depo-beige.vercel.app'],
    ['localhost', 'https://localhost'],
    ['IP literal', 'https://169.254.169.254'],
    ['URL rota', 'no-es-una-url'],
  ])('no sale a la red con %s', async (_caso, url) => {
    mocks.tenantFindUnique.mockResolvedValue(tiendaDashboard(url));
    const r = await getUnfulfilledCount(`t-dash-${_caso.replace(/\W+/g, '')}`);
    expect(r.count).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('una tienda de Shopify sigue por su camino de siempre', async () => {
    mocks.tenantFindUnique.mockResolvedValue({
      id: 't',
      shopifyStoreUrl: 'mitienda.myshopify.com',
      shopifyToken: 'cifrado',
      codEnabled: false,
      dashboardSourceEnabled: false,
      dashboardUrl: null,
      dashboardToken: null,
    });
    // `shopifyAccessForTenant` está mockeado devolviendo null → 'decrypt-failed'.
    // Lo que importa es que NO entró por la rama del dashboard.
    const r = await getUnfulfilledCount('t-shopify');
    expect(r.skipped).toBe('decrypt-failed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
