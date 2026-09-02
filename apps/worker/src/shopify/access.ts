import { db } from '../db';
import {
  getValidShopifyAccessToken,
  resolveShopifyAccessToken,
  type ShopifyAccessResolution,
  type ShopifyTokenTenant,
} from './token';

/**
 * Atajo del worker: `resolveShopifyAccessToken` con el Prisma del worker y
 * SHOPIFY_API_KEY/SHOPIFY_API_SECRET si están en el entorno (D29). Hoy Render
 * NO los tiene: en ese caso el módulo avisa una vez por tenant y usa el
 * access guardado tal cual (la web lo renueva cuando alguien la toca, y el
 * "Ejecutar" manual lo renueva antes de encolar). Para un tenant legacy el
 * resultado es idéntico a `decryptIfPresent(tenant.shopifyToken)`.
 */
export function resolveShopifyAccessForTenant(tenant: ShopifyTokenTenant): Promise<ShopifyAccessResolution> {
  return resolveShopifyAccessToken({
    db,
    tenant,
    clientId: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
  });
}

export function shopifyAccessForTenant(tenant: ShopifyTokenTenant): Promise<string | null> {
  return getValidShopifyAccessToken({
    db,
    tenant,
    clientId: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
  });
}
