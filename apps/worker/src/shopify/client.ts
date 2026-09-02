import axios, { AxiosInstance } from 'axios';
import logger from '../logger';
import type { ShopifyTokenSource } from './graphql-client';

/**
 * Con un string el cliente es el de siempre (header fijo, byte a byte). Con
 * un proveedor (token expirable, D29) el header se resuelve en cada request
 * para que un job largo no siga mandando un access vencido. REST no reintenta
 * en 401: los tenants con token expirable hablan GraphQL (la app pública no
 * tiene REST) y los legacy no vencen.
 */
export function createShopifyClient(storeUrl: string, token: ShopifyTokenSource): AxiosInstance {
  const client = axios.create({
    baseURL: `https://${storeUrl}/admin/api/2024-01`,
    headers: {
      ...(typeof token === 'string' ? { 'X-Shopify-Access-Token': token } : {}),
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });

  if (typeof token !== 'string') {
    client.interceptors.request.use(async (config) => {
      config.headers.set('X-Shopify-Access-Token', await token());
      return config;
    });
  }

  client.interceptors.response.use((response) => {
    // Axios header values are `string | number | true | AxiosHeaders`, so we
    // coerce to string before string methods. See label.ts for the same fix.
    const callLimitRaw = response.headers['x-shopify-shop-api-call-limit'];
    const callLimit = typeof callLimitRaw === 'string' ? callLimitRaw : null;
    if (callLimit) {
      const [used, max] = callLimit.split('/').map(Number);
      if (used > max * 0.8) {
        logger.warn({ used, max }, 'Shopify rate limit high');
      }
    }
    return response;
  });

  return client;
}
