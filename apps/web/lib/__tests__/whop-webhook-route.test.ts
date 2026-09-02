import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

/**
 * POST /api/webhooks/whop (D34). Firma Standard Webhooks fail-closed,
 * dedupe por entrega, resolución de la compra sin acreditar en ambigüedad,
 * y la MISMA acreditación que MP (`settlePaidPurchase`). Y ninguna línea de
 * log con el cuerpo ni el email.
 */
const mocks = vi.hoisted(() => ({
  receiptCreate: vi.fn(),
  receiptDeleteMany: vi.fn(),
  purchaseFindFirst: vi.fn(),
  purchaseFindMany: vi.fn(),
  purchaseFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  settle: vi.fn(),
  refund: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    webhookReceipt: { create: mocks.receiptCreate, deleteMany: mocks.receiptDeleteMany },
    creditPurchase: {
      findFirst: mocks.purchaseFindFirst,
      findMany: mocks.purchaseFindMany,
      findUnique: mocks.purchaseFindUnique,
    },
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock('@/lib/credit-accrual', () => ({
  settlePaidPurchase: mocks.settle,
  refundPaidPurchase: mocks.refund,
}));

import { POST, GET } from '@/app/api/webhooks/whop/route';
import { signStandardWebhook } from '@/lib/whop';

const RAW_SECRET = crypto.randomBytes(24);
const SECRET_WHSEC = `whsec_${RAW_SECRET.toString('base64')}`;
const EMAIL = 'juana@tienda.uy';

const PAYMENT_OK = {
  type: 'payment.succeeded',
  data: { id: 'pay_x', user: { email: EMAIL }, metadata: {} },
};

interface PostOpts {
  secret?: string;
  webhookId?: string;
  timestamp?: number;
  signature?: string | null;
  headers?: Record<string, string>;
}

function post(body: object | string, opts: PostOpts = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const secret = opts.secret ?? SECRET_WHSEC;
  const id = opts.webhookId ?? 'msg_1';
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    ...(opts.headers ?? {}),
  };
  const sig =
    opts.signature === undefined ? `v1,${signStandardWebhook(secret, id, ts, raw)}` : opts.signature;
  if (sig !== null) headers['webhook-signature'] = sig;
  return POST(
    new NextRequest('https://autoenvia.com/api/webhooks/whop', { method: 'POST', body: raw, headers }),
  );
}

let logged: unknown[][];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHOP_WEBHOOK_SECRET = SECRET_WHSEC;
  logged = [];
  for (const m of ['info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
  mocks.receiptCreate.mockResolvedValue({});
  mocks.receiptDeleteMany.mockResolvedValue({ count: 1 });
  mocks.purchaseFindFirst.mockResolvedValue(null);
  mocks.purchaseFindMany.mockResolvedValue([{ id: 'cp-1' }]);
  mocks.purchaseFindUnique.mockResolvedValue(null);
  mocks.userFindUnique.mockResolvedValue({ id: 'u1' });
  mocks.settle.mockResolvedValue({ credited: true, holderTenantId: 't-holder', shipments: 100, firstPaidPack: true });
  mocks.refund.mockResolvedValue({ refunded: true, debited: 100 });
});

afterEach(() => {
  delete process.env.WHOP_WEBHOOK_SECRET;
});

function nothingLoggedContains(needle: string) {
  const flat = JSON.stringify(logged);
  expect(flat).not.toContain(needle);
}

describe('firma (fail-closed)', () => {
  it('sin WHOP_WEBHOOK_SECRET → 503 y no toca la base', async () => {
    delete process.env.WHOP_WEBHOOK_SECRET;
    const res = await post(PAYMENT_OK);
    expect(res.status).toBe(503);
    expect(mocks.receiptCreate).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('firma válida con secret whsec_ (base64) → 200 y acredita con whop:pay_x', async () => {
    const res = await post(PAYMENT_OK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, credited: true });
    expect(mocks.settle).toHaveBeenCalledWith({
      purchaseId: 'cp-1',
      externalPaymentId: 'whop:pay_x',
      rail: 'whop',
    });
  });

  it('firma válida con secret plano (sin prefijo) → 200', async () => {
    process.env.WHOP_WEBHOOK_SECRET = 'secreto-plano';
    const res = await post(PAYMENT_OK, { secret: 'secreto-plano' });
    expect(res.status).toBe(200);
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });

  it('firma con otro secret → 401 sin tocar la base', async () => {
    const res = await post(PAYMENT_OK, { secret: 'whsec_' + crypto.randomBytes(24).toString('base64') });
    expect(res.status).toBe(401);
    expect(mocks.receiptCreate).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('cuerpo alterado después de firmar → 401', async () => {
    const raw = JSON.stringify(PAYMENT_OK);
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v1,${signStandardWebhook(SECRET_WHSEC, 'msg_1', ts, raw)}`;
    const res = await post(raw.replace('pay_x', 'pay_y'), { timestamp: ts, signature: sig });
    expect(res.status).toBe(401);
  });

  it('faltan headers → 401', async () => {
    expect((await post(PAYMENT_OK, { signature: null })).status).toBe(401);
    expect((await post(PAYMENT_OK, { headers: { 'webhook-timestamp': '' } })).status).toBe(401);
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('timestamp a 6 minutos → 401; a 4 minutos → 200', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await post(PAYMENT_OK, { timestamp: now - 360 })).status).toBe(401);
    expect((await post(PAYMENT_OK, { timestamp: now + 360 })).status).toBe(401);
    expect((await post(PAYMENT_OK, { timestamp: now - 240 })).status).toBe(200);
  });

  it('header con dos firmas, la segunda válida → 200', async () => {
    const raw = JSON.stringify(PAYMENT_OK);
    const ts = Math.floor(Date.now() / 1000);
    const good = signStandardWebhook(SECRET_WHSEC, 'msg_1', ts, raw);
    const bad = crypto.randomBytes(32).toString('base64');
    const res = await post(raw, { timestamp: ts, signature: `v1,${bad} v1,${good}` });
    expect(res.status).toBe(200);
  });

  it('firma de largo distinto no rompe (401, no 500)', async () => {
    const res = await post(PAYMENT_OK, { signature: 'v1,abc' });
    expect(res.status).toBe(401);
  });
});

describe('cuerpo y dedupe', () => {
  it('JSON inválido con firma válida → 400', async () => {
    const res = await post('{no es json', {});
    expect(res.status).toBe(400);
    expect(mocks.receiptCreate).not.toHaveBeenCalled();
  });

  it('webhook-id repetido (P2002 en el recibo) → 200 duplicate sin acreditar', async () => {
    mocks.receiptCreate.mockRejectedValueOnce({ code: 'P2002' });
    const res = await post(PAYMENT_OK);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.receiptCreate.mock.calls[0][0].data).toEqual({
      source: 'whop',
      topic: 'payment.succeeded',
      webhookId: 'msg_1',
    });
  });

  it('si acreditar tira, se borra el recibo y se responde 500 (Whop reintenta)', async () => {
    mocks.settle.mockRejectedValueOnce(new Error('db caída'));
    const res = await post(PAYMENT_OK);
    expect(res.status).toBe(500);
    expect(mocks.receiptDeleteMany).toHaveBeenCalledWith({
      where: { source: 'whop', topic: 'payment.succeeded', webhookId: 'msg_1' },
    });
  });

  it('evento que no interesa (membership.went_valid) → 200 ignored', async () => {
    const res = await post({ action: 'membership.went_valid', data: { id: 'mem_1' } });
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('payment_succeeded (con guion bajo) también acredita', async () => {
    const res = await post({ action: 'payment_succeeded', data: { id: 'pay_x', user: { email: EMAIL } } });
    expect(await res.json()).toEqual({ received: true, credited: true });
  });

  it('GET → 200 ok', async () => {
    expect((await GET()).status).toBe(200);
  });
});

describe('resolución de la compra (fail-closed)', () => {
  it('sin payment id → 200 flagged sin acreditar', async () => {
    const res = await post({ type: 'payment.succeeded', data: { user: { email: EMAIL } } });
    expect(await res.json()).toEqual({ ok: true, flagged: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('metadata.purchaseId de una compra de Whop → se usa directo, sin mirar el email', async () => {
    mocks.purchaseFindFirst.mockResolvedValueOnce({ id: 'cp-meta' });
    await post({ type: 'payment.succeeded', data: { id: 'pay_x', metadata: { purchaseId: 'cp-meta' } } });
    expect(mocks.purchaseFindFirst.mock.calls[0][0].where).toEqual({
      id: 'cp-meta',
      mpExternalRef: { startsWith: 'whop|' },
    });
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ purchaseId: 'cp-meta' }));
  });

  it('metadata.purchaseId que no es una compra de Whop → flagged, no cae al email', async () => {
    mocks.purchaseFindFirst.mockResolvedValueOnce(null);
    const res = await post({
      type: 'payment.succeeded',
      data: { id: 'pay_x', user: { email: EMAIL }, metadata: { purchaseId: 'cp-de-mp' } },
    });
    expect(await res.json()).toEqual({ ok: true, flagged: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('metadata.userId gana sobre el email', async () => {
    await post({
      type: 'payment.succeeded',
      data: { id: 'pay_x', user: { email: 'otra@x.uy' }, metadata: { userId: 'u1' } },
    });
    expect(mocks.userFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.userFindUnique.mock.calls[0][0].where).toEqual({ id: 'u1' });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });

  it('email se busca en minúsculas y la PENDING se filtra por usuario, whop|, 24 h', async () => {
    await post({ type: 'payment.succeeded', data: { id: 'pay_x', user: { email: 'Juana@Tienda.UY' } } });
    expect(mocks.userFindUnique.mock.calls[0][0].where).toEqual({ email: EMAIL });
    const where = mocks.purchaseFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenant: { userId: 'u1' },
      mpExternalRef: { startsWith: 'whop|' },
      status: 'PENDING',
    });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThan(23 * 3600 * 1000);
    expect(where.packId).toBeUndefined();
  });

  it('metadata.packId filtra las candidatas', async () => {
    await post({
      type: 'payment.succeeded',
      data: { id: 'pay_x', user: { email: EMAIL }, metadata: { packId: 'pack_100' } },
    });
    expect(mocks.purchaseFindMany.mock.calls[0][0].where.packId).toBe('pack_100');
  });

  it('usuario desconocido → flagged sin acreditar', async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    const res = await post(PAYMENT_OK);
    expect(await res.json()).toEqual({ ok: true, flagged: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('cero PENDING → flagged; dos PENDING → flagged (nunca se adivina)', async () => {
    mocks.purchaseFindMany.mockResolvedValueOnce([]);
    expect(await (await post(PAYMENT_OK)).json()).toEqual({ ok: true, flagged: true });
    mocks.purchaseFindMany.mockResolvedValueOnce([{ id: 'cp-1' }, { id: 'cp-2' }]);
    expect(await (await post(PAYMENT_OK, { webhookId: 'msg_2' })).json()).toEqual({ ok: true, flagged: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('settle devuelve already_processed → 200 credited:false con la razón', async () => {
    mocks.settle.mockResolvedValueOnce({ credited: false, reason: 'already_processed' });
    const res = await post(PAYMENT_OK);
    expect(await res.json()).toEqual({ received: true, credited: false, reason: 'already_processed' });
  });
});

describe('reembolsos', () => {
  it('payment.refunded de un pago acreditado → refundPaidPurchase', async () => {
    mocks.purchaseFindUnique.mockResolvedValueOnce({ id: 'cp-1' });
    const res = await post({ type: 'payment.refunded', data: { id: 'pay_x' } });
    expect(mocks.purchaseFindUnique.mock.calls[0][0].where).toEqual({ mpPaymentId: 'whop:pay_x' });
    expect(mocks.refund).toHaveBeenCalledWith('cp-1', 'whop');
    expect(await res.json()).toEqual({ received: true, refunded: true });
  });

  it('dispute.created con payment_id → mismo camino; pago desconocido → ignored', async () => {
    const res = await post({ type: 'dispute.created', data: { id: 'dsp_1', payment_id: 'pay_nunca' } });
    expect(mocks.purchaseFindUnique.mock.calls[0][0].where).toEqual({ mpPaymentId: 'whop:pay_nunca' });
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});

describe('logs', () => {
  it('ningún log contiene el cuerpo ni el email, en éxito, flagged, ni error', async () => {
    await post(PAYMENT_OK);
    mocks.userFindUnique.mockResolvedValueOnce(null);
    await post(PAYMENT_OK, { webhookId: 'msg_2' });
    mocks.purchaseFindMany.mockResolvedValueOnce([]);
    await post(PAYMENT_OK, { webhookId: 'msg_3' });
    mocks.settle.mockRejectedValueOnce(new Error('boom'));
    await post(PAYMENT_OK, { webhookId: 'msg_4' });
    await post(PAYMENT_OK, { secret: 'whsec_' + crypto.randomBytes(24).toString('base64') });

    expect(logged.length).toBeGreaterThan(0);
    nothingLoggedContains(EMAIL);
    nothingLoggedContains('juana');
    nothingLoggedContains(JSON.stringify(PAYMENT_OK));
    nothingLoggedContains('"user"');
    nothingLoggedContains(SECRET_WHSEC);
  });
});
