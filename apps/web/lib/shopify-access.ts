import { db } from '@/lib/db';
import {
  getValidShopifyAccessToken,
  resolveShopifyAccessToken,
  SHOPIFY_TOKEN_JOB_SKEW_MS,
  type ShopifyAccessResolution,
  type ShopifyTokenTenant,
} from '@/lib/shopify-token';

export interface ShopifyAccessOptions {
  /** Ver `ResolveShopifyAccessInput.skewMs`. Default 5 min; el warm-up previo a encolar usa 55. */
  skewMs?: number;
}

/**
 * Atajo de `apps/web`: `getValidShopifyAccessToken` con el Prisma de la app y
 * el client_id/secret de la app pública (Vercel los tiene). Reemplaza al
 * `decryptIfPresent(tenant.shopifyToken)` de antes en cada consumidor: para
 * un tenant legacy devuelve exactamente el mismo string; para uno del App
 * Store renueva bajo demanda (D29).
 */
export function shopifyAccessForTenant(tenant: ShopifyTokenTenant, opts: ShopifyAccessOptions = {}): Promise<string | null> {
  return getValidShopifyAccessToken({
    db,
    tenant,
    clientId: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
    skewMs: opts.skewMs,
  });
}

export function resolveShopifyAccessForTenant(
  tenant: ShopifyTokenTenant,
  opts: ShopifyAccessOptions = {},
): Promise<ShopifyAccessResolution> {
  return resolveShopifyAccessToken({
    db,
    tenant,
    clientId: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
    skewMs: opts.skewMs,
  });
}

/**
 * Renueva el token del tenant si NO le queda casi la hora entera (margen de
 * 55 min, el mismo con el que arrancan los jobs), sin devolverlo: lo usan
 * los "Ejecutar" manuales antes de encolar el job, para que el worker (que
 * hoy no tiene el secret en Render) arranque con ~1 h de token y no con los
 * 6 min que el margen corto dejaba pasar. Best-effort y nunca tira: si no se
 * pudo, el job va a reportar el motivo en su runlog.
 */
export async function warmShopifyToken(tenantId: string): Promise<void> {
  try {
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
    });
    if (!tenant?.shopifyToken) return;
    await shopifyAccessForTenant(tenant, { skewMs: SHOPIFY_TOKEN_JOB_SKEW_MS });
  } catch (err) {
    console.warn('[shopify/token] warm-up antes de encolar falló', {
      tenantId,
      message: String((err as { message?: unknown })?.message ?? '').split('\n')[0].slice(0, 200),
    });
  }
}
