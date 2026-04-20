import axios, { AxiosInstance } from 'axios';
import logger from '../logger';

export function createShopifyClient(storeUrl: string, token: string): AxiosInstance {
  const client = axios.create({
    baseURL: `https://${storeUrl}/admin/api/2024-01`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });

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
