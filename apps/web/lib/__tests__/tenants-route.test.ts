import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/v1/tenants ("Nueva tienda" del switcher). D31: el trial es por
 * CUENTA, no por tienda → una tienda adicional nace con 0 envíos, explícito.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  tenantCreate: vi.fn(),
  tenantFindMany: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));
vi.mock('@/lib/db', () => ({
  db: { tenant: { create: mocks.tenantCreate, findMany: mocks.tenantFindMany } },
}));

import { POST } from '@/app/api/v1/tenants/route';

function post(body: unknown) {
  return POST(
    new Request('https://autoenvia.com/api/v1/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
  mocks.tenantCreate.mockImplementation(async (args: { data: { name: string; slug: string } }) => ({
    id: 't-2',
    name: args.data.name,
    slug: args.data.slug,
  }));
});

describe('POST /api/v1/tenants', () => {
  it('sin sesión → 401 y no crea nada', async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    expect((await post({ name: 'Nueva tienda' })).status).toBe(401);
    expect(mocks.tenantCreate).not.toHaveBeenCalled();
  });

  it('tienda adicional: shipmentCredits 0 explícito (no el default del schema ni el trial)', async () => {
    const res = await post({ name: 'Nueva tienda' });
    expect(res.status).toBe(200);
    const data = mocks.tenantCreate.mock.calls[0][0].data;
    expect(data.userId).toBe('u1');
    expect(data.shipmentCredits).toBe(0);
    expect(data.referralBonusCredits).toBeUndefined();
    expect(data.shopifyStoreUrl).toBeUndefined();
  });

  it('nombre vacío → "Mi tienda", y sigue en 0', async () => {
    await post({ name: '   ' });
    const data = mocks.tenantCreate.mock.calls[0][0].data;
    expect(data.name).toBe('Mi tienda');
    expect(data.shipmentCredits).toBe(0);
  });
});
