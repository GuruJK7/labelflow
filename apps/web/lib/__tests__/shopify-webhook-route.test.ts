import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

process.env.SHOPIFY_API_SECRET = 'secreto-de-test';

/**
 * POST /api/webhooks/shopify (orders/paid): qué encola y qué no según el
 * modo de procesamiento del tenant (D33). "Cada hora" promete juntar lo que
 * entra y procesarlo en punto; el webhook encolaba al instante sin mirar
 * `cronSchedule` y la guía salía a las 10:03 (revisión 2026-09-02).
 */
const mocks = vi.hoisted(() => ({
  tenantFindFirst: vi.fn(),
  receiptCreate: vi.fn(),
  enqueueProcessOrders: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: { tenant: { findFirst: mocks.tenantFindFirst }, webhookReceipt: { create: mocks.receiptCreate } },
}));
vi.mock('@/lib/queue', () => ({ enqueueProcessOrders: mocks.enqueueProcessOrders }));

import { Prisma } from '@prisma/client';
import { POST } from '@/app/api/webhooks/shopify/route';
import { CRON_CADA_HORA, CRON_INMEDIATO } from '../onboarding-state';

function firmar(body: string): string {
  return crypto.createHmac('sha256', 'secreto-de-test').update(body, 'utf8').digest('base64');
}

function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest('https://autoenvia.com/api/webhooks/shopify', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': firmar(body),
        'x-shopify-topic': 'orders/paid',
        'x-shopify-shop-domain': 'acme.myshopify.com',
        'x-shopify-webhook-id': 'wh-1',
        ...headers,
      },
    }),
  );
}

const BODY = JSON.stringify({ id: 1042, financial_status: 'paid' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.receiptCreate.mockResolvedValue({ id: 'r1' });
  mocks.enqueueProcessOrders.mockResolvedValue({ id: 'job-1' });
});

describe('POST /api/webhooks/shopify', () => {
  it('firma inválida → 401 sin tocar la base', async () => {
    const res = await post(BODY, { 'x-shopify-hmac-sha256': firmar(BODY + 'x') });
    expect(res.status).toBe(401);
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueueProcessOrders).not.toHaveBeenCalled();
  });

  it('modo Inmediato (*/15): guarda el receipt y encola WEBHOOK', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', cronSchedule: CRON_INMEDIATO });
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(mocks.tenantFindFirst.mock.calls[0][0].select).toEqual({ id: true, cronSchedule: true });
    expect(mocks.receiptCreate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueProcessOrders).toHaveBeenCalledWith('t1', 'WEBHOOK');
  });

  it('modo Cada hora (0 * * * *): guarda el receipt, responde 200 y NO encola (lo levanta el cron en punto)', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', cronSchedule: CRON_CADA_HORA });
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deferred: 'cada_hora' });
    expect(mocks.receiptCreate).toHaveBeenCalledTimes(1);
    expect(mocks.receiptCreate.mock.calls[0][0].data).toMatchObject({ source: 'shopify', topic: 'orders/paid', webhookId: 'wh-1', tenantId: 't1' });
    expect(mocks.enqueueProcessOrders).not.toHaveBeenCalled();
  });

  it('cron a medida del admin (personalizado) sigue encolando como siempre', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', cronSchedule: '0,30 9-18 * * 1-5' });
    await post(BODY);
    expect(mocks.enqueueProcessOrders).toHaveBeenCalledWith('t1', 'WEBHOOK');
  });

  it('reintento de Shopify (mismo webhookId, P2002) → 200 duplicate sin encolar, en cualquier modo', async () => {
    mocks.tenantFindFirst.mockResolvedValue({ id: 't1', cronSchedule: CRON_INMEDIATO });
    mocks.receiptCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );
    const res = await post(BODY);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(mocks.enqueueProcessOrders).not.toHaveBeenCalled();
  });

  it('tienda desconocida → 200 sin encolar', async () => {
    mocks.tenantFindFirst.mockResolvedValue(null);
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(mocks.enqueueProcessOrders).not.toHaveBeenCalled();
  });

  // 🔴 Sonda de la comprobación automática del App Store: firmada con el secreto
  // de la app, sin topic ni dominio. Antes recibía 401 y Shopify marcaba en rojo
  // «verifica webhooks con firmas HMAC». Tiene que acusar recibo con 200.
  it('sonda firmada sin topic ni dominio: 200 y no toca la base', async () => {
    const body = '{}';
    // Sin `post()`: ese helper inyecta topic y dominio por defecto y la sonda
    // justamente no los trae.
    const res = await POST(
      new NextRequest('https://autoenvia.com/api/webhooks/shopify', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': firmar(body) },
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
  });
});
