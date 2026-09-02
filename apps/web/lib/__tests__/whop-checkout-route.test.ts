import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/** GET /api/credit-packs/whop-checkout?pack= (D34). */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  purchaseCreate: vi.fn(),
  purchaseUpdate: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: { creditPurchase: { create: mocks.purchaseCreate, update: mocks.purchaseUpdate } },
}));

import { GET } from '@/app/api/credit-packs/whop-checkout/route';

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
