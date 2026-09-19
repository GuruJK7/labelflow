import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

process.env.SHOPIFY_API_SECRET = 'secreto-de-test';

const mocks = vi.hoisted(() => ({ updateMany: vi.fn(), receiptCreate: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: { tenant: { updateMany: mocks.updateMany }, webhookReceipt: { create: mocks.receiptCreate } },
}));

import { Prisma } from '@prisma/client';
import { POST } from '@/app/api/shopify/uninstalled/route';
import { fakeTenantUpdateMany, type FakeTenantRow } from './_shopify-route-utils';

function firmar(body: string): string {
  return crypto.createHmac('sha256', 'secreto-de-test').update(body, 'utf8').digest('base64');
}

function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest('https://autoenvia.com/api/shopify/uninstalled', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );
}

let filas: FakeTenantRow[];

beforeEach(() => {
  vi.clearAllMocks();
  filas = [
    { id: 't-mayus', shopifyStoreUrl: 'MiTienda.myshopify.com', shopifyToken: 'enc-1' },
    { id: 't-otra', shopifyStoreUrl: 'otra.myshopify.com', shopifyToken: 'enc-2' },
  ];
  mocks.updateMany.mockImplementation(fakeTenantUpdateMany(filas));
  mocks.receiptCreate.mockResolvedValue({});
});

describe('POST /api/shopify/uninstalled — entregas repetidas', () => {
  const body = JSON.stringify({ myshopify_domain: 'otra.myshopify.com' });
  const headers = {
    'x-shopify-hmac-sha256': firmar(body),
    'x-shopify-shop-domain': 'otra.myshopify.com',
    'x-shopify-webhook-id': 'wh-123',
  };

  it('la primera entrega anota el recibo y limpia el token', async () => {
    const res = await post(body, headers);
    expect(res.status).toBe(200);
    expect(mocks.receiptCreate).toHaveBeenCalledWith({
      data: { source: 'shopify', topic: 'app/uninstalled', webhookId: 'wh-123', shopDomain: 'otra.myshopify.com' },
    });
    expect(filas[1].shopifyToken).toBeNull();
  });

  it('🔴 la REENTREGA del mismo webhook no toca la base: el token de la reinstalación sobrevive', async () => {
    // Desinstala → procesamos pero Shopify no vio el 200 → reinstala (token
    // nuevo) → llega el reintento del uninstalled viejo. Antes ese reintento
    // ponía en null el token NUEVO.
    filas[1].shopifyToken = 'enc-NUEVO-de-la-reinstalacion';
    mocks.receiptCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );
    const res = await post(body, headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(filas[1].shopifyToken).toBe('enc-NUEVO-de-la-reinstalacion');
  });

  it('si anotar el recibo falla por otra cosa, la limpieza sigue (es el camino de antes)', async () => {
    mocks.receiptCreate.mockRejectedValue(new Error('db caída'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(body, headers);
    expect(res.status).toBe(200);
    expect(filas[1].shopifyToken).toBeNull();
    spy.mockRestore();
  });

  it('sin x-shopify-webhook-id no hay recibo, y se limpia igual', async () => {
    const { 'x-shopify-webhook-id': _omitido, ...sinId } = headers;
    void _omitido;
    const res = await post(body, sinId);
    expect(res.status).toBe(200);
    expect(mocks.receiptCreate).not.toHaveBeenCalled();
    expect(filas[1].shopifyToken).toBeNull();
  });
});

describe('POST /api/shopify/uninstalled', () => {
  it('sin firma válida: 401 y no toca la base', async () => {
    const body = JSON.stringify({ myshopify_domain: 'mitienda.myshopify.com' });
    const res = await post(body, { 'x-shopify-hmac-sha256': firmar(body + 'x') });
    expect(res.status).toBe(401);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("la fila guardada como 'MiTienda.myshopify.com' se limpia con el dominio en minúsculas que manda Shopify (D18)", async () => {
    const body = JSON.stringify({ myshopify_domain: 'mitienda.myshopify.com' });
    const res = await post(body, {
      'x-shopify-hmac-sha256': firmar(body),
      'x-shopify-shop-domain': 'mitienda.myshopify.com',
    });
    expect(res.status).toBe(200);

    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany.mock.calls[0][0]).toEqual({
      where: { shopifyStoreUrl: { equals: 'mitienda.myshopify.com', mode: 'insensitive' } },
      data: { shopifyToken: null },
    });
    // La propiedad, no sólo la forma: la fila con mayúsculas quedó sin token
    // y la otra tienda no se tocó.
    expect(filas[0].shopifyToken).toBeNull();
    expect(filas[1].shopifyToken).toBe('enc-2');
  });

  it('header de tienda distinto al cuerpo firmado: 401, sin tocar la base', async () => {
    const body = JSON.stringify({ myshopify_domain: 'mitienda.myshopify.com' });
    const res = await post(body, {
      'x-shopify-hmac-sha256': firmar(body),
      'x-shopify-shop-domain': 'otra.myshopify.com',
    });
    expect(res.status).toBe(401);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
