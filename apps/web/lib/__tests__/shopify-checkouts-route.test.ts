import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

process.env.SHOPIFY_API_SECRET = 'secreto-de-test';

const mocks = vi.hoisted(() => ({
  tenantFindFirst: vi.fn(),
  receiptCreate: vi.fn(),
  cartFindUnique: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { findFirst: mocks.tenantFindFirst },
    webhookReceipt: { create: mocks.receiptCreate },
    recoverCart: { findUnique: mocks.cartFindUnique },
  },
}));

import { POST } from '@/app/api/webhooks/shopify/checkouts/route';
import { fakeTenantFindFirst } from './_shopify-route-utils';

function firmar(body: string): string {
  return crypto.createHmac('sha256', 'secreto-de-test').update(body, 'utf8').digest('base64');
}

function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest('https://autoenvia.com/api/webhooks/shopify/checkouts', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );
}

const recoverConfig = {
  id: 'rc-1',
  isActive: true,
  subscriptionStatus: 'ACTIVE',
  delayMinutes: 30,
  secondMessageEnabled: false,
  secondMessageDelayMinutes: 0,
  messageTemplate2: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  const fake = fakeTenantFindFirst([
    { id: 't-mayus', shopifyStoreUrl: 'MiTienda.myshopify.com', isActive: true },
  ]);
  // El `select` de la ruta trae recoverConfig; la tabla en memoria sólo sabe
  // evaluar el `where`, así que se le pega la config al resultado.
  mocks.tenantFindFirst.mockImplementation(async (args) => {
    const fila = await fake(args);
    return fila ? { ...fila, recoverConfig } : null;
  });
  mocks.receiptCreate.mockResolvedValue({});
  mocks.cartFindUnique.mockResolvedValue(null);
});

describe('POST /api/webhooks/shopify/checkouts', () => {
  it('sin firma válida: 401 y no toca la base', async () => {
    const body = JSON.stringify({ id: 99 });
    const res = await post(body, {
      'x-shopify-hmac-sha256': firmar(body + 'x'),
      'x-shopify-topic': 'checkouts/update',
      'x-shopify-shop-domain': 'mitienda.myshopify.com',
    });
    expect(res.status).toBe(401);
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled();
  });

  it("la fila guardada como 'MiTienda.myshopify.com' se encuentra con el dominio en minúsculas y el checkout se procesa para ese tenant (D18)", async () => {
    // completed_at: el camino más corto que igual prueba que el tenant se
    // encontró (busca el carrito con SU tenantId) sin armar toda la cadena de jobs.
    const body = JSON.stringify({ id: 99, token: 'tok', completed_at: '2026-09-01T00:00:00Z' });
    const res = await post(body, {
      'x-shopify-hmac-sha256': firmar(body),
      'x-shopify-topic': 'checkouts/update',
      'x-shopify-shop-domain': 'mitienda.myshopify.com',
      'x-shopify-webhook-id': 'wh-1',
    });
    expect(res.status).toBe(200);

    expect(mocks.tenantFindFirst.mock.calls[0][0].where).toEqual({
      shopifyStoreUrl: { equals: 'mitienda.myshopify.com', mode: 'insensitive' },
      isActive: true,
    });
    expect(mocks.receiptCreate.mock.calls[0][0].data.tenantId).toBe('t-mayus');
    expect(mocks.cartFindUnique.mock.calls[0][0].where).toEqual({
      tenantId_shopifyCheckoutId: { tenantId: 't-mayus', shopifyCheckoutId: '99' },
    });
  });

  // 🔴 Sonda de la comprobación automática del App Store: firmada con el secreto
  // de la app, sin topic ni dominio. Antes recibía 401 y Shopify marcaba en rojo
  // «verifica webhooks con firmas HMAC». Tiene que acusar recibo con 200.
  it('sonda firmada sin topic ni dominio: 200 y no toca la base', async () => {
    const body = '{}'
    const res = await post(body, { 'x-shopify-hmac-sha256': firmar(body) })
    expect(res.status).toBe(200)
    expect(mocks.tenantFindFirst).not.toHaveBeenCalled()
  })
});
