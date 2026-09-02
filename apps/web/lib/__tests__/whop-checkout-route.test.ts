import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/** GET /api/credit-packs/whop-checkout?pack= (D34). */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  purchaseCreate: vi.fn(),
  purchaseUpdate: vi.fn(),
  purchaseFindFirst: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    creditPurchase: { create: mocks.purchaseCreate, update: mocks.purchaseUpdate, findFirst: mocks.purchaseFindFirst },
  },
}));

import { GET } from '@/app/api/credit-packs/whop-checkout/route';
import { WHOP_PENDING_REUSE_MINUTES } from '@/lib/whop';

const URLS = { pack_100: 'https://whop.com/checkout/plan_100?d2c=true' };

function get(pack?: string) {
  const url = new URL('https://autoenvia.com/api/credit-packs/whop-checkout');
  if (pack) url.searchParams.set('pack', pack);
  return GET(new NextRequest(url));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  process.env.WHOP_CHECKOUT_URLS = JSON.stringify(URLS);
  mocks.getAuthenticatedTenant.mockResolvedValue({ userId: 'u1', tenantId: 'tenant-1' });
  mocks.purchaseCreate.mockResolvedValue({ id: 'cp-new' });
  mocks.purchaseUpdate.mockResolvedValue({});
  mocks.purchaseFindFirst.mockResolvedValue(null); // sin PENDING reciente
});
afterEach(() => {
  delete process.env.WHOP_CHECKOUT_URLS;
});

describe('GET /api/credit-packs/whop-checkout', () => {
  it('sin sesión → 401 y no crea nada', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValueOnce(null);
    expect((await get('pack_100')).status).toBe(401);
    expect(mocks.purchaseCreate).not.toHaveBeenCalled();
  });

  it('pack inválido → 400; sin pack → 400', async () => {
    expect((await get('pack_7')).status).toBe(400);
    expect((await get()).status).toBe(400);
    expect(mocks.purchaseCreate).not.toHaveBeenCalled();
  });

  it('pack sin URL en WHOP_CHECKOUT_URLS → 404 sin crear la compra', async () => {
    const res = await get('pack_50');
    expect(res.status).toBe(404);
    expect(mocks.purchaseCreate).not.toHaveBeenCalled();
  });

  it('sin WHOP_CHECKOUT_URLS → 404', async () => {
    delete process.env.WHOP_CHECKOUT_URLS;
    expect((await get('pack_100')).status).toBe(404);
  });

  it('OK → crea PENDING con precios de la tabla, mpExternalRef whop|<id> y redirige 302 a la URL del env', async () => {
    const res = await get('pack_100');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(URLS.pack_100);

    const created = mocks.purchaseCreate.mock.calls[0][0].data;
    expect(created).toMatchObject({
      tenantId: 'tenant-1',
      packId: 'pack_100',
      shipments: 100,
      pricePerShipmentUyu: 15,
      totalPriceUyu: 1500,
      status: 'PENDING',
    });
    expect(created.mpExternalRef).toMatch(/^whop\|tmp_/);
    expect(mocks.purchaseUpdate).toHaveBeenCalledWith({
      where: { id: 'cp-new' },
      data: { mpExternalRef: 'whop|cp-new' },
    });
  });
});

/**
 * Revisión 2026-09-02: el webhook resuelve el pago por usuario y exige UNA
 * sola PENDING de Whop reciente. Dos clics en "Pagar con Whop" dejaban dos
 * PENDING, el pago llegaba `flagged` y no acreditaba. Ahora el segundo clic
 * reutiliza la compra del primero (mismo usuario, mismo pack, < 30 min).
 */
describe('GET /api/credit-packs/whop-checkout — dos clics, una PENDING', () => {
  it('busca una PENDING reciente del mismo usuario y pack, sólo de Whop, dentro de la ventana', async () => {
    const before = Date.now();
    await get('pack_100');
    expect(mocks.purchaseFindFirst).toHaveBeenCalledTimes(1);
    const args = mocks.purchaseFindFirst.mock.calls[0][0];
    expect(args.where).toMatchObject({
      tenant: { userId: 'u1' },
      packId: 'pack_100',
      status: 'PENDING',
      mpExternalRef: { startsWith: 'whop|' },
    });
    const since = (args.where.createdAt as { gte: Date }).gte.getTime();
    expect(before - since).toBeGreaterThanOrEqual(WHOP_PENDING_REUSE_MINUTES * 60 * 1000 - 5);
    expect(before - since).toBeLessThan(WHOP_PENDING_REUSE_MINUTES * 60 * 1000 + 1000);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('con una PENDING reciente → NO crea otra, redirige igual al link del pack', async () => {
    mocks.purchaseFindFirst.mockResolvedValueOnce({ id: 'cp-previa' });
    const res = await get('pack_100');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(URLS.pack_100);
    expect(mocks.purchaseCreate).not.toHaveBeenCalled();
    expect(mocks.purchaseUpdate).not.toHaveBeenCalled();
  });

  it('sin PENDING reciente (o vencida la ventana) → crea la compra como siempre', async () => {
    mocks.purchaseFindFirst.mockResolvedValueOnce(null);
    const res = await get('pack_100');
    expect(res.status).toBe(302);
    expect(mocks.purchaseCreate).toHaveBeenCalledTimes(1);
  });

  it('pack inválido o sin URL: ni siquiera consulta compras previas', async () => {
    await get('pack_7');
    await get('pack_50');
    expect(mocks.purchaseFindFirst).not.toHaveBeenCalled();
  });
});
