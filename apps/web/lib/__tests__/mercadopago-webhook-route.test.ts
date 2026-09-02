import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

/**
 * POST /api/webhooks/mercadopago — después del refactor (D34) el webhook es
 * un router de estados sobre `lib/credit-accrual.ts`. Acá se fija que cada
 * estado de MP llama a la función correcta con `rail: 'mercadopago'`.
 */
process.env.MERCADOPAGO_WEBHOOK_SECRET = 'mp-secret-de-test';

const mocks = vi.hoisted(() => ({
  paymentGet: vi.fn(),
  settle: vi.fn(),
  fail: vi.fn(),
  refund: vi.fn(),
}));
vi.mock('@/lib/mercadopago', () => ({
  getPaymentClient: () => ({ get: mocks.paymentGet }),
  getPreApprovalClient: () => ({ get: vi.fn() }),
  PLANS: {},
}));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/credit-accrual', () => ({
  settlePaidPurchase: mocks.settle,
  failPendingPurchase: mocks.fail,
  refundPaidPurchase: mocks.refund,
}));

import { POST } from '@/app/api/webhooks/mercadopago/route';

function post(body: object, opts: { sign?: boolean } = { sign: true }) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const requestId = 'req-1';
  const dataId = (body as { data?: { id?: string } }).data?.id;
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', 'mp-secret-de-test').update(manifest).digest('hex');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign) {
    headers['x-signature'] = `ts=${ts},v1=${v1}`;
    headers['x-request-id'] = requestId;
  }
  return POST(
    new NextRequest('https://autoenvia.com/api/webhooks/mercadopago', {
      method: 'POST',
      body: raw,
      headers,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.settle.mockResolvedValue({ credited: true });
  mocks.fail.mockResolvedValue(undefined);
  mocks.refund.mockResolvedValue({ refunded: true, debited: 0 });
});

describe('POST /api/webhooks/mercadopago (packs)', () => {
  it('sin firma → 401 y no consulta el pago', async () => {
    const res = await post({ type: 'payment', data: { id: '111' } }, { sign: false });
    expect(res.status).toBe(401);
    expect(mocks.paymentGet).not.toHaveBeenCalled();
  });

  it('approved con external_reference pkg|<id> → settlePaidPurchase con rail mercadopago', async () => {
    mocks.paymentGet.mockResolvedValueOnce({ status: 'approved', external_reference: 'pkg|cp-9' });
    const res = await post({ type: 'payment', data: { id: '111' } });
    expect(res.status).toBe(200);
    expect(mocks.settle).toHaveBeenCalledWith({
      purchaseId: 'cp-9',
      externalPaymentId: '111',
      rail: 'mercadopago',
    });
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it('rejected → failPendingPurchase', async () => {
    mocks.paymentGet.mockResolvedValueOnce({ status: 'rejected', external_reference: 'pkg|cp-9' });
    await post({ type: 'payment', data: { id: '112' } });
    expect(mocks.fail).toHaveBeenCalledWith('cp-9', 'mercadopago');
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it.each(['refunded', 'cancelled', 'charged_back'])('%s → refundPaidPurchase', async (status) => {
    mocks.paymentGet.mockResolvedValueOnce({ status, external_reference: 'pkg|cp-9' });
    await post({ type: 'payment', data: { id: '113' } });
    expect(mocks.refund).toHaveBeenCalledWith('cp-9', 'mercadopago');
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('pending → no llama a nada', async () => {
    mocks.paymentGet.mockResolvedValueOnce({ status: 'pending', external_reference: 'pkg|cp-9' });
    const res = await post({ type: 'payment', data: { id: '114' } });
    expect(res.status).toBe(200);
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});
