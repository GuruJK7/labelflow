import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

process.env.SHOPIFY_API_SECRET = 'secreto-de-test';

const mocks = vi.hoisted(() => ({
  tenantFindFirst: vi.fn(),
  receiptCreate: vi.fn(),
  gdprCreate: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { findFirst: mocks.tenantFindFirst },
    webhookReceipt: { create: mocks.receiptCreate },
    gdprRequest: { create: mocks.gdprCreate },
  },
}));

import { POST } from '@/app/api/webhooks/shopify/gdpr/route';
import { fakeTenantFindFirst } from './_shopify-route-utils';

function firmar(body: string): string {
  return crypto.createHmac('sha256', 'secreto-de-test').update(body, 'utf8').digest('base64');
}

function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest('https://autoenvia.com/api/webhooks/shopify/gdpr', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  mocks.tenantFindFirst.mockImplementation(
    fakeTenantFindFirst([{ id: 't-mayus', shopifyStoreUrl: 'MiTienda.myshopify.com' }]),
  );
  mocks.receiptCreate.mockResolvedValue({});
  mocks.gdprCreate.mockResolvedValue({});
});
afterEach(() => info.mockRestore());

describe('POST /api/webhooks/shopify/gdpr', () => {
  it('sin firma válida: 401 y no toca la base', async () => {
    const body = JSON.stringify({ shop_domain: 'mitienda.myshopify.com' });
    const res = await post(body, {
      'x-shopify-hmac-sha256': firmar(body + 'x'),
      'x-shopify-topic': 'shop/redact',
      'x-shopify-shop-domain': 'mitienda.myshopify.com',
    });
    expect(res.status).toBe(401);
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
    expect(mocks.gdprCreate).not.toHaveBeenCalled();
  });

  it("la fila guardada como 'MiTienda.myshopify.com' se encuentra con el dominio en minúsculas y el GdprRequest queda con su tenantId (D18)", async () => {
    const body = JSON.stringify({ customer: { id: 7, email: 'c@x.com' } });
    const res = await post(body, {
      'x-shopify-hmac-sha256': firmar(body),
      'x-shopify-topic': 'customers/redact',
      'x-shopify-shop-domain': 'mitienda.myshopify.com',
      'x-shopify-webhook-id': 'wh-1',
    });
    expect(res.status).toBe(200);

    expect(mocks.tenantFindFirst.mock.calls[0][0].where).toEqual({
      shopifyStoreUrl: { equals: 'mitienda.myshopify.com', mode: 'insensitive' },
    });
    expect(mocks.receiptCreate.mock.calls[0][0].data.tenantId).toBe('t-mayus');
    const data = mocks.gdprCreate.mock.calls[0][0].data;
    expect(data.tenantId).toBe('t-mayus');
    expect(data.topic).toBe('CUSTOMERS_REDACT');
    expect(data.customerId).toBe('7');
  });
});
