import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * lib/credit-accrual.ts — la única función de acreditación de packs (D34).
 * MercadoPago y Whop la llaman; acá se fija la semántica que se extrajo del
 * webhook de MP sin cambiarla: holder, idempotencia, primer pack, kickback.
 */
const mocks = vi.hoisted(() => ({
  purchaseFindUnique: vi.fn(),
  purchaseCount: vi.fn(),
  purchaseUpdateMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantUpdate: vi.fn(),
  accrualCreate: vi.fn(),
  transaction: vi.fn(),
  trackServer: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    creditPurchase: {
      findUnique: mocks.purchaseFindUnique,
      count: mocks.purchaseCount,
      updateMany: mocks.purchaseUpdateMany,
    },
    tenant: {
      findUnique: mocks.tenantFindUnique,
      findFirst: mocks.tenantFindFirst,
      update: mocks.tenantUpdate,
    },
    referralCreditAccrual: { create: mocks.accrualCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/analytics.server', () => ({ trackServer: mocks.trackServer }));

import {
  settlePaidPurchase,
  failPendingPurchase,
  refundPaidPurchase,
  accrueReferralKickback,
} from '@/lib/credit-accrual';

const PURCHASE = {
  id: 'cp-1',
  tenantId: 'tienda-nueva',
  packId: 'pack_100',
  shipments: 100,
  totalPriceUyu: 1500,
  status: 'PENDING',
};

/** Tabla de tenants en memoria: userId y referidos. */
const TENANTS: Record<string, { userId: string; referredById: string | null; shipmentCredits: number }> = {
  'tienda-nueva': { userId: 'u1', referredById: null, shipmentCredits: 3 },
  'tienda-vieja': { userId: 'u1', referredById: null, shipmentCredits: 40 }, // holder de u1
  'referidor': { userId: 'u2', referredById: null, shipmentCredits: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.purchaseFindUnique.mockResolvedValue({ ...PURCHASE });
  mocks.purchaseCount.mockResolvedValue(0);
  mocks.purchaseUpdateMany.mockResolvedValue({ count: 1 });
  mocks.tenantFindUnique.mockImplementation(async ({ where }) => TENANTS[where.id] ?? null);
  // El holder es el tenant más viejo del usuario: para u1 es tienda-vieja.
  mocks.tenantFindFirst.mockImplementation(async ({ where }) => {
    const holder: Record<string, string> = { u1: 'tienda-vieja', u2: 'referidor' };
    return holder[where.userId] ? { id: holder[where.userId] } : null;
  });
  mocks.tenantUpdate.mockResolvedValue({});
  mocks.transaction.mockResolvedValue([]);
  mocks.trackServer.mockResolvedValue(undefined);
});

describe('settlePaidPurchase', () => {
  it('PENDING → PAID acredita al HOLDER (no al tenant que compró) con shipmentCredits y creditsPurchased', async () => {
    const r = await settlePaidPurchase({ purchaseId: 'cp-1', externalPaymentId: 'whop:pay_1', rail: 'whop' });
    expect(r).toEqual({ credited: true, holderTenantId: 'tienda-vieja', shipments: 100, firstPaidPack: true });

    const upd = mocks.purchaseUpdateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'cp-1', status: 'PENDING' });
    expect(upd.data).toMatchObject({ status: 'PAID', mpPaymentId: 'whop:pay_1' });
    expect(upd.data.paidAt).toBeInstanceOf(Date);

    const credit = mocks.tenantUpdate.mock.calls[0][0];
    expect(credit.where).toEqual({ id: 'tienda-vieja' });
    expect(credit.data).toEqual({
      shipmentCredits: { increment: 100 },
      creditsPurchased: { increment: 100 },
    });
  });

  it('segunda llamada (ya PAID) → already_processed sin tocar el tenant', async () => {
    mocks.purchaseUpdateMany.mockResolvedValueOnce({ count: 0 });
    const r = await settlePaidPurchase({ purchaseId: 'cp-1', externalPaymentId: '123', rail: 'mercadopago' });
    expect(r).toEqual({ credited: false, reason: 'already_processed' });
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
    expect(mocks.trackServer).not.toHaveBeenCalled();
  });

  it('P2002 en el update (otro purchase ya tiene ese pago) → duplicate_payment sin acreditar', async () => {
    mocks.purchaseUpdateMany.mockRejectedValueOnce({ code: 'P2002' });
    const r = await settlePaidPurchase({ purchaseId: 'cp-1', externalPaymentId: 'whop:pay_1', rail: 'whop' });
    expect(r).toEqual({ credited: false, reason: 'duplicate_payment' });
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('otros errores del update se propagan (no se tragan)', async () => {
    mocks.purchaseUpdateMany.mockRejectedValueOnce(new Error('db caída'));
    await expect(
      settlePaidPurchase({ purchaseId: 'cp-1', externalPaymentId: 'x', rail: 'whop' }),
    ).rejects.toThrow('db caída');
  });

  it('purchase inexistente → not_found', async () => {
    mocks.purchaseFindUnique.mockResolvedValueOnce(null);
    const r = await settlePaidPurchase({ purchaseId: 'nada', externalPaymentId: 'x', rail: 'whop' });
    expect(r).toEqual({ credited: false, reason: 'not_found' });
    expect(mocks.purchaseUpdateMany).not.toHaveBeenCalled();
  });

  it('firstPaidPack sólo con priorPaidCount 0, y dispara subscription_activated una vez con el rail', async () => {
    const r1 = await settlePaidPurchase({ purchaseId: 'cp-1', externalPaymentId: 'a', rail: 'mercadopago' });
    expect(r1).toMatchObject({ credited: true, firstPaidPack: true });
    expect(mocks.trackServer).toHaveBeenCalledTimes(1);
    expect(mocks.trackServer).toHaveBeenCalledWith('tienda-nueva', 'subscription_activated', {
      plan: 'pack_100',
      amount_uyu: 1500,
      rail: 'mercadopago',
    });
    // El conteo excluye la propia compra.
    expect(mocks.purchaseCount.mock.calls[0][0].where).toEqual({
      tenantId: 'tienda-nueva',
      status: 'PAID',
      id: { not: 'cp-1' },
    });

    mocks.purchaseCount.mockResolvedValueOnce(2);
    const r2 = await settlePaidPurchase({ purchaseId: 'cp-1', externalPaymentId: 'b', rail: 'mercadopago' });
    expect(r2).toMatchObject({ credited: true, firstPaidPack: false });
    expect(mocks.trackServer).toHaveBeenCalledTimes(1);
  });
});

describe('accrueReferralKickback', () => {
  it('referido → transacción con floor(0.2*n) al HOLDER del referidor y el accrual de auditoría', async () => {
    TENANTS['tienda-nueva'].referredById = 'referidor';
    try {
      await accrueReferralKickback('tienda-nueva', 'cp-1', 55, 'whop');
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.accrualCreate).toHaveBeenCalledWith({
        data: {
          referrerTenantId: 'referidor',
          refereeTenantId: 'tienda-nueva',
          sourcePurchaseId: 'cp-1',
          shipmentsAccrued: 11,
        },
      });
      expect(mocks.tenantUpdate).toHaveBeenCalledWith({
        where: { id: 'referidor' },
        data: { shipmentCredits: { increment: 11 }, referralCreditsEarned: { increment: 11 } },
      });
    } finally {
      TENANTS['tienda-nueva'].referredById = null;
    }
  });

  it('sin referidor → no hace nada', async () => {
    await accrueReferralKickback('tienda-nueva', 'cp-1', 100);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('self-referral (mismo userId) → no acredita', async () => {
    TENANTS['tienda-nueva'].referredById = 'tienda-vieja'; // mismo dueño u1
    try {
      await accrueReferralKickback('tienda-nueva', 'cp-1', 100);
      expect(mocks.transaction).not.toHaveBeenCalled();
    } finally {
      TENANTS['tienda-nueva'].referredById = null;
    }
  });

  it('P2002 en la transacción (ya acreditado) → skip silencioso; otros errores se propagan', async () => {
    TENANTS['tienda-nueva'].referredById = 'referidor';
    try {
      mocks.transaction.mockRejectedValueOnce({ code: 'P2002' });
      await expect(accrueReferralKickback('tienda-nueva', 'cp-1', 100)).resolves.toBeUndefined();
      mocks.transaction.mockRejectedValueOnce(new Error('otra'));
      await expect(accrueReferralKickback('tienda-nueva', 'cp-1', 100)).rejects.toThrow('otra');
    } finally {
      TENANTS['tienda-nueva'].referredById = null;
    }
  });
});

describe('failPendingPurchase / refundPaidPurchase', () => {
  it('fail: sólo transiciona PENDING → FAILED', async () => {
    await failPendingPurchase('cp-1', 'mercadopago');
    expect(mocks.purchaseUpdateMany).toHaveBeenCalledWith({
      where: { id: 'cp-1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  });

  it('refund: PAID → REFUNDED y débito al holder con clamp al saldo', async () => {
    // holder tienda-vieja tiene 40; la compra fue de 100 → debita 40.
    const r = await refundPaidPurchase('cp-1', 'whop');
    expect(r).toEqual({ refunded: true, debited: 40 });
    expect(mocks.purchaseUpdateMany.mock.calls[0][0].where).toEqual({ id: 'cp-1', status: 'PAID' });
    expect(mocks.tenantUpdate).toHaveBeenCalledWith({
      where: { id: 'tienda-vieja' },
      data: { shipmentCredits: { decrement: 40 } },
    });
  });

  it('refund de algo que no estaba PAID → no debita', async () => {
    mocks.purchaseUpdateMany.mockResolvedValueOnce({ count: 0 });
    const r = await refundPaidPurchase('cp-1', 'whop');
    expect(r).toEqual({ refunded: false, debited: 0 });
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });
});
