import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** GET /api/credit-packs/me — whopPacks refleja el env sin filtrar las URLs (D34). */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindMany: vi.fn(),
  purchaseFindMany: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: {
      findUnique: mocks.tenantFindUnique,
      findFirst: mocks.tenantFindFirst,
      findMany: mocks.tenantFindMany,
    },
    creditPurchase: { findMany: mocks.purchaseFindMany },
  },
}));

import { GET } from '@/app/api/credit-packs/me/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedTenant.mockResolvedValue({ userId: 'u1', tenantId: 'tenant-1' });
  // getCreditHolderTenantId: findUnique(userId) + findFirst(holder)
  mocks.tenantFindUnique.mockImplementation(async ({ select }) =>
    select?.userId
      ? { userId: 'u1' }
      : {
          shipmentCredits: 12,
          creditsPurchased: 100,
          creditsConsumed: 88,
          referralCreditsEarned: 0,
          referralBonusCredits: 3,
        },
  );
  mocks.tenantFindFirst.mockResolvedValue({ id: 'tenant-1' });
  mocks.tenantFindMany.mockResolvedValue([{ id: 'tenant-1' }]);
  mocks.purchaseFindMany.mockResolvedValue([]);
});
afterEach(() => {
  delete process.env.WHOP_CHECKOUT_URLS;
});

describe('GET /api/credit-packs/me', () => {
  it('whopPacks lista los ids con URL y la respuesta NO contiene la URL', async () => {
    process.env.WHOP_CHECKOUT_URLS = JSON.stringify({
      pack_100: 'https://whop.com/checkout/plan_abc',
      pack_500: 'https://whop.com/checkout/plan_def',
      pack_9: 'https://whop.com/checkout/plan_inexistente',
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('whop.com');
    const { data } = JSON.parse(text);
    expect(data.whopPacks).toEqual(['pack_100', 'pack_500', 'pack_9']);
    expect(data.balance.total).toBe(15);
    expect(data.balance.referralBonusCredits).toBe(3);
    expect(data.packs.map((p: { id: string }) => p.id)).toContain('pack_10');
  });

  it('sin env → whopPacks vacío', async () => {
    const { data } = await (await GET()).json();
    expect(data.whopPacks).toEqual([]);
  });

  it('sin sesión → 401', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
  });
});
