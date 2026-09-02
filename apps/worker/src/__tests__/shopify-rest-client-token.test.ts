// D29 (revisión): el cliente REST con un string es el de siempre (header
// fijo); con un proveedor resuelve el header en cada request.
import { describe, it, expect, vi } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';
import { createShopifyClient } from '../shopify/client';

const SHOP = 'aura.myshopify.com';

function captureAdapter() {
  const headers: string[] = [];
  const adapter = async (config: InternalAxiosRequestConfig) => {
    headers.push(String(config.headers.get('X-Shopify-Access-Token')));
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  return { adapter, headers };
}

describe('createShopifyClient (REST) y el origen del token', () => {
  it('string: header fijo, como siempre', async () => {
    const { adapter, headers } = captureAdapter();
    const c = createShopifyClient(SHOP, 'shpat_fijo');
    c.defaults.adapter = adapter;
    await c.get('/orders/1.json');
    await c.get('/orders/2.json');
    expect(headers).toEqual(['shpat_fijo', 'shpat_fijo']);
    expect(c.defaults.headers['X-Shopify-Access-Token']).toBe('shpat_fijo');
  });

  it('proveedor: se resuelve en cada request y no queda en los defaults', async () => {
    const { adapter, headers } = captureAdapter();
    let n = 0;
    const provider = vi.fn(async () => `shpat_v${++n}`);
    const c = createShopifyClient(SHOP, provider);
    c.defaults.adapter = adapter;
    await c.get('/orders/1.json');
    await c.get('/orders/2.json');
    expect(headers).toEqual(['shpat_v1', 'shpat_v2']);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(c.defaults.headers['X-Shopify-Access-Token']).toBeUndefined();
  });
});
