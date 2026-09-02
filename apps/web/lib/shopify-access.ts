import { db } from '@/lib/db';
import {
  getValidShopifyAccessToken,
  resolveShopifyAccessToken,
  type ShopifyAccessResolution,
  type ShopifyTokenTenant,
} from '@/lib/shopify-token';

/**
 * Atajo de `apps/web`: `getValidShopifyAccessToken` con el Prisma de la app y
 * el client_id/secret de la app pública (Vercel los tiene). Reemplaza al
 * `decryptIfPresent(tenant.shopifyToken)` de antes en cada consumidor: para
 * un tenant legacy devuelve exactamente el mismo string; para uno del App
 * Store renueva bajo demanda (D29).
 */
export function shopifyAccessForTenant(tenant: ShopifyTokenTenant): Promise<string | null> {
  return getValidShopifyAccessToken({
    db,
    tenant,
    clientId: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
  });
}

export function resolveShopifyAccessForTenant(tenant: ShopifyTokenTenant): Promise<ShopifyAccessResolution> {
  return resolveShopifyAccessToken({
    db,
    tenant,
    clientId: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
  });
}

/**
 * Renueva el token del tenant si está por vencer, sin devolverlo: lo usan
 * los "Ejecutar" manuales antes de encolar el job, para que el worker (que
 * hoy no tiene el secret en Render) arranque con un par fresco. Best-effort
 * y nunca tira: si no se pudo, el job va a reportar el motivo en su runlog.
 */
export async function warmShopifyToken(tenantId: string): Promise<void> {
  try {
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
    });
    if (!tenant?.shopifyToken) return;
    await shopifyAccessForTenant(tenant);
  } catch (err) {
    console.warn('[shopify/token] warm-up antes de encolar falló', {
      tenantId,
      message: String((err as { message?: unknown })?.message ?? '').split('\n')[0].slice(0, 200),
    });
  }
}
