import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

/**
 * `app_purchases_one_time/update` — el webhook que acredita envíos comprados
 * por la Billing API de Shopify.
 *
 * Es el endpoint que más caro sale si está flojo: quien logre que acredite
 * sin haber pagado, se lleva envíos gratis. Los tres candados que se prueban:
 *
 *   1. Firma HMAC con el secreto de la app ANTES de tocar la base.
 *   2. La cantidad de envíos NO sale del cuerpo del webhook, sale de la fila
 *      `CreditPurchase` que creamos nosotros. Un cuerpo que diga
 *      "shipments: 999999" no cambia nada.
 *   3. Sólo `ACTIVE` acredita. `PENDING`, `DECLINED`, `EXPIRED` y el
 *      deprecado `ACCEPTED`, no.
 */
const SECRET = 'test-shopify-app-secret';

const mocks = vi.hoisted(() => ({
  purchaseFindFirst: vi.fn(),
  purchaseUpdateMany: vi.fn(),
  receiptCreate: vi.fn(),
  settle: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    creditPurchase: { findFirst: mocks.purchaseFindFirst, updateMany: mocks.purchaseUpdateMany },
    webhookReceipt: { create: mocks.receiptCreate },
  },
}));
vi.mock('@/lib/credit-accrual', () => ({ settlePaidPurchase: mocks.settle }));

import { POST } from '@/app/api/webhooks/shopify/app-purchases/route';

const CHARGE_GID = 'gid://shopify/AppPurchaseOneTime/9876543210';

function cuerpo(status: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    app_purchase_one_time: {
      admin_graphql_api_id: CHARGE_GID,
      name: 'AutoEnvía · 250 envíos',
      status,
      ...extra,
    },
  });
}

function firmar(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
}

function pedido(body: string, opts: { hmac?: string; topic?: string; webhookId?: string } = {}) {
  return new Request('https://autoenvia.com/api/webhooks/shopify/app-purchases', {
    method: 'POST',
    headers: {
      'x-shopify-hmac-sha256': opts.hmac ?? firmar(body),
      'x-shopify-topic': opts.topic ?? 'app_purchases_one_time/update',
      'x-shopify-shop-domain': 'kaia-store.myshopify.com',
      'x-shopify-webhook-id': opts.webhookId ?? 'wh_1',
      'content-type': 'application/json',
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = SECRET;
  mocks.purchaseFindFirst.mockResolvedValue({ id: 'cp_1', status: 'PENDING' });
  mocks.purchaseUpdateMany.mockResolvedValue({ count: 1 });
  mocks.receiptCreate.mockResolvedValue({});
  mocks.settle.mockResolvedValue({ credited: true, holderTenantId: 't1', shipments: 250 });
});
afterEach(() => {
  delete process.env.SHOPIFY_API_SECRET;
});

describe('firma', () => {
  it('un cuerpo sin firma válida no toca la base', async () => {
    const body = cuerpo('ACTIVE');
    const res = await POST(pedido(body, { hmac: 'firma-inventada' }) as never);
    expect(res.status).toBe(401);
    expect(mocks.purchaseFindFirst).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('sin los headers obligatorios tampoco', async () => {
    const body = cuerpo('ACTIVE');
    const req = new Request('https://autoenvia.com/api/webhooks/shopify/app-purchases', {
      method: 'POST',
      body,
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(mocks.settle).not.toHaveBeenCalled();
  });


  // 🔴 Sonda de la comprobación automática del App Store: firmada con el secreto
  // de la app, sin topic ni dominio. Antes recibía 401 y Shopify marcaba en rojo
  // «verifica webhooks con firmas HMAC». Tiene que acusar recibo con 200.
  it('sonda firmada sin topic ni dominio: 200 y no acredita nada', async () => {
    const body = cuerpo('ACTIVE');
    const req = new Request('https://autoenvia.com/api/webhooks/shopify/app-purchases', {
      method: 'POST',
      body,
      headers: { 'x-shopify-hmac-sha256': firmar(body) },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('un cuerpo alterado después de firmar se rechaza', async () => {
    const original = cuerpo('PENDING');
    const alterado = cuerpo('ACTIVE');
    const res = await POST(pedido(alterado, { hmac: firmar(original) }) as never);
    expect(res.status).toBe(401);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});

describe('acreditación', () => {
  it('ACTIVE acredita la compra que corresponde al GID', async () => {
    const res = await POST(pedido(cuerpo('ACTIVE')) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, credited: true });
    expect(mocks.purchaseFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mpPreferenceId: CHARGE_GID } }),
    );
    expect(mocks.settle).toHaveBeenCalledWith({
      purchaseId: 'cp_1',
      externalPaymentId: `shopify:${CHARGE_GID}`,
      rail: 'shopify',
    });
  });

  it('el cuerpo REST manda el estado en minúsculas y también acredita', async () => {
    // GraphQL devuelve ACTIVE; el cuerpo del webhook viene "active". Si el
    // handler comparara sin normalizar, ningún pago acreditaría nunca.
    const res = await POST(pedido(cuerpo('active')) as never);
    expect(await res.json()).toEqual({ received: true, credited: true });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });

  it('🔴 la cantidad de envíos NO se lee del webhook', async () => {
    await POST(pedido(cuerpo('ACTIVE', { shipments: 999999, price: '0.01' })) as never);
    // settle recibe sólo el id de la compra: los envíos salen de la fila.
    expect(mocks.settle).toHaveBeenCalledWith({
      purchaseId: 'cp_1',
      externalPaymentId: `shopify:${CHARGE_GID}`,
      rail: 'shopify',
    });
  });

  it('un GID que no conocemos no acredita nada y corta los reintentos', async () => {
    mocks.purchaseFindFirst.mockResolvedValue(null);
    const res = await POST(pedido(cuerpo('ACTIVE')) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unknown: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  for (const estado of ['PENDING', 'ACCEPTED']) {
    it(`${estado} no acredita`, async () => {
      const res = await POST(pedido(cuerpo(estado)) as never);
      expect(await res.json()).toMatchObject({ credited: false });
      expect(mocks.settle).not.toHaveBeenCalled();
      expect(mocks.purchaseUpdateMany).not.toHaveBeenCalled();
    });
  }

  for (const estado of ['DECLINED', 'EXPIRED']) {
    it(`${estado} marca FAILED, y sólo si seguía PENDING`, async () => {
      const res = await POST(pedido(cuerpo(estado)) as never);
      expect(await res.json()).toMatchObject({ credited: false, status: estado });
      expect(mocks.settle).not.toHaveBeenCalled();
      expect(mocks.purchaseUpdateMany).toHaveBeenCalledWith({
        where: { id: 'cp_1', status: 'PENDING' },
        data: { status: 'FAILED' },
      });
    });
  }
});

describe('reentregas', () => {
  it('una reentrega del mismo webhook no acredita dos veces', async () => {
    const { Prisma } = await import('@prisma/client');
    mocks.receiptCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    const res = await POST(pedido(cuerpo('ACTIVE')) as never);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('otro topic en esta ruta se ignora sin tocar nada', async () => {
    const body = cuerpo('ACTIVE');
    const res = await POST(pedido(body, { topic: 'orders/paid' }) as never);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(mocks.settle).not.toHaveBeenCalled();
  });
});
