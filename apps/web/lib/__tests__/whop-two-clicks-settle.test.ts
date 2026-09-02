import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

/**
 * Escenario completo de la revisión 2026-09-02: "dos clics → una PENDING → el
 * pago acredita". Corre el checkout de Whop y el webhook de verdad sobre una
 * tabla de CreditPurchase en memoria (el `where` se evalúa, no se mockea la
 * respuesta), así el test falla si cualquiera de los dos deja de coincidir
 * con el otro. Sin la reutilización, el segundo clic dejaba dos PENDING, el
 * webhook las veía ambiguas (`candidates: 2`) y respondía `flagged`: 0 envíos.
 */
interface PurchaseRow {
  id: string;
  tenantId: string;
  packId: string;
  status: string;
  mpExternalRef: string;
  createdAt: Date;
}
const TENANT_USER: Record<string, string> = { 'tenant-1': 'u1' };
const USERS = [{ id: 'u1', email: 'juana@tienda.uy' }];

type Where = Record<string, unknown>;
function matches(row: PurchaseRow, where: Where): boolean {
  for (const [k, v] of Object.entries(where)) {
    switch (k) {
      case 'tenant':
        if (TENANT_USER[row.tenantId] !== (v as { userId: string }).userId) return false;
        break;
      case 'id':
        if (row.id !== v) return false;
        break;
      case 'packId':
        if (row.packId !== v) return false;
        break;
      case 'status':
        if (row.status !== v) return false;
        break;
      case 'mpExternalRef':
        if (!row.mpExternalRef.startsWith((v as { startsWith: string }).startsWith)) return false;
        break;
      case 'createdAt':
        if (row.createdAt.getTime() < (v as { gte: Date }).gte.getTime()) return false;
        break;
      default:
        throw new Error(`filtro no contemplado "${k}"`);
    }
  }
  return true;
}

const state = vi.hoisted(() => ({ purchases: [] as PurchaseRow[], seq: 0 }));
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  settle: vi.fn(),
  refund: vi.fn(),
  receiptCreate: vi.fn(),
  receiptDeleteMany: vi.fn(),
}));

vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/credit-accrual', () => ({ settlePaidPurchase: mocks.settle, refundPaidPurchase: mocks.refund }));
vi.mock('@/lib/db', () => ({
  db: {
    creditPurchase: {
      findFirst: async ({ where }: { where: Where }) => {
        const rows = state.purchases.filter((r) => matches(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ? { id: rows[0].id, packId: rows[0].packId } : null;
      },
      findMany: async ({ where }: { where: Where }) =>
        state.purchases.filter((r) => matches(r, where)).map((r) => ({ id: r.id, packId: r.packId })),
      findUnique: async () => null,
      create: async ({ data }: { data: Omit<PurchaseRow, 'id' | 'createdAt'> }) => {
        const row: PurchaseRow = { ...data, id: `cp-${++state.seq}`, createdAt: new Date() };
        state.purchases.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<PurchaseRow> }) => {
        const row = state.purchases.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return { id: row.id };
      },
    },
    webhookReceipt: { create: mocks.receiptCreate, deleteMany: mocks.receiptDeleteMany },
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) =>
        USERS.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
    },
  },
}));

import { GET as checkout } from '@/app/api/credit-packs/whop-checkout/route';
import { POST as webhook } from '@/app/api/webhooks/whop/route';
import { signStandardWebhook } from '@/lib/whop';

const SECRET = `whsec_${crypto.randomBytes(24).toString('base64')}`;

function click(pack = 'pack_100') {
  const url = new URL('https://autoenvia.com/api/credit-packs/whop-checkout');
  url.searchParams.set('pack', pack);
  return checkout(new NextRequest(url));
}
function pay(webhookId: string, body: object) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  return webhook(
    new NextRequest('https://autoenvia.com/api/webhooks/whop', {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': String(ts),
        'webhook-signature': `v1,${signStandardWebhook(SECRET, webhookId, ts, raw)}`,
      },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.purchases = [];
  state.seq = 0;
  for (const m of ['info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  process.env.WHOP_CHECKOUT_URLS = JSON.stringify({ pack_100: 'https://whop.com/checkout/plan_100' });
  process.env.WHOP_PLAN_IDS = JSON.stringify({ pack_100: 'plan_100' });
  process.env.WHOP_WEBHOOK_SECRET = SECRET;
  mocks.getAuthenticatedTenant.mockResolvedValue({ userId: 'u1', tenantId: 'tenant-1' });
  mocks.receiptCreate.mockResolvedValue({});
  mocks.settle.mockImplementation(async ({ purchaseId }: { purchaseId: string }) => ({
    credited: true, holderTenantId: 'tenant-1', shipments: 100, firstPaidPack: true, purchaseId,
  }));
});
afterEach(() => {
  delete process.env.WHOP_CHECKOUT_URLS;
  delete process.env.WHOP_PLAN_IDS;
  delete process.env.WHOP_WEBHOOK_SECRET;
});

describe('dos clics → una PENDING → el pago acredita', () => {
  it('el segundo clic reutiliza la compra del primero y el webhook acredita esa única PENDING', async () => {
    expect((await click()).status).toBe(302);
    expect((await click()).status).toBe(302);

    const pendientes = state.purchases.filter((p) => p.status === 'PENDING');
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0].mpExternalRef).toBe(`whop|${pendientes[0].id}`);

    const res = await pay('msg_1', {
      type: 'payment.succeeded',
      data: { id: 'pay_1', plan_id: 'plan_100', user: { email: 'Juana@tienda.uy' }, metadata: {} },
    });
    expect(await res.json()).toEqual({ received: true, credited: true });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    expect(mocks.settle).toHaveBeenCalledWith({
      purchaseId: pendientes[0].id,
      externalPaymentId: 'whop:pay_1',
      rail: 'whop',
    });
  });

  it('control: con dos PENDING el mismo pago NO acredita, queda para revisar', async () => {
    // POR QUÉ DOS PACKS Y NO UNA COMPRA ENVEJECIDA. La versión anterior de este
    // control envejecía la primera compra 31 minutos para forzar la segunda
    // PENDING. Dejó de servir por dos motivos encadenados: la ventana de
    // reutilización pasó a 24 h (31 minutos ya no envejecen nada) y, sobre
    // todo, el webhook mira la MISMA ventana — así que cualquier compra vieja
    // para el checkout también es invisible para el webhook y nunca puede ser
    // la segunda candidata. Hoy la ambigüedad real es otra: dos PENDING vivas
    // de packs distintos y un pago que no dice de qué pack es.
    process.env.WHOP_CHECKOUT_URLS = JSON.stringify({
      pack_100: 'https://whop.com/checkout/plan_100',
      pack_500: 'https://whop.com/checkout/plan_500',
    });
    await click('pack_100');
    await click('pack_500');
    expect(state.purchases.filter((p) => p.status === 'PENDING')).toHaveLength(2);

    const res = await pay('msg_2', {
      type: 'payment.succeeded',
      data: { id: 'pay_2', plan_id: 'plan_100', user: { email: 'juana@tienda.uy' }, metadata: {} },
    });
    expect(await res.json()).toEqual({ ok: true, flagged: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('con metadata.packId la ambigüedad se resuelve y acredita el pack pagado', async () => {
    // El otro lado del control: la misma situación deja de ser ambigua apenas
    // el pago dice de qué pack es. Sin este caso, el de arriba pasaría igual si
    // el webhook dejara de acreditar SIEMPRE.
    process.env.WHOP_CHECKOUT_URLS = JSON.stringify({
      pack_100: 'https://whop.com/checkout/plan_100',
      pack_500: 'https://whop.com/checkout/plan_500',
    });
    await click('pack_100');
    await click('pack_500');

    const res = await pay('msg_3', {
      type: 'payment.succeeded',
      data: {
        id: 'pay_3',
        plan_id: 'plan_100',
        user: { email: 'juana@tienda.uy' },
        metadata: { packId: 'pack_100' },
      },
    });
    expect(await res.json()).toEqual({ received: true, credited: true });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    const pagada = state.purchases.find((p) => p.packId === 'pack_100');
    expect(mocks.settle).toHaveBeenCalledWith({
      purchaseId: pagada!.id,
      externalPaymentId: 'whop:pay_3',
      rail: 'whop',
    });
  });

  it('un pack distinto no se reutiliza: cada pack tiene su PENDING', async () => {
    process.env.WHOP_CHECKOUT_URLS = JSON.stringify({
      pack_100: 'https://whop.com/checkout/plan_100',
      pack_500: 'https://whop.com/checkout/plan_500',
    });
    await click('pack_100');
    await click('pack_500');
    expect(state.purchases.map((p) => p.packId)).toEqual(['pack_100', 'pack_500']);
  });
});
