import { db } from '../db';
import {
  getValidShopifyAccessToken,
  resolveShopifyAccessToken,
  SHOPIFY_TOKEN_JOB_SKEW_MS,
  type ShopifyAccessResolution,
  type ShopifyTokenTenant,
} from './token';
import type { ShopifyTokenProvider, ShopifyTokenSource } from './graphql-client';

export interface ShopifyAccessOptions {
  /** Ver `ResolveShopifyAccessInput.skewMs`. Los jobs pasan `SHOPIFY_TOKEN_JOB_SKEW_MS`. */
  skewMs?: number;
}

/**
 * Atajo del worker: `resolveShopifyAccessToken` con el Prisma del worker y
 * SHOPIFY_API_KEY/SHOPIFY_API_SECRET si están en el entorno (D29). Hoy Render
 * NO los tiene: en ese caso el módulo avisa una vez por tenant y usa el
 * access guardado tal cual (la web lo renueva cuando alguien la toca, y el
 * "Ejecutar" manual lo renueva antes de encolar). Para un tenant legacy el
 * resultado es idéntico a `decryptIfPresent(tenant.shopifyToken)`.
 */
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

export function shopifyAccessForTenant(tenant: ShopifyTokenTenant, opts: ShopifyAccessOptions = {}): Promise<string | null> {
  return getValidShopifyAccessToken({
    db,
    tenant,
    clientId: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
    skewMs: opts.skewMs,
  });
}

/**
 * Resolución con la que arranca un job del worker: margen de 55 min, así
 * cada corrida empieza con ~1 h entera de token (una rotación por corrida,
 * barata). Sin secret en el entorno no cambia nada respecto del margen corto.
 */
export function resolveShopifyAccessForJob(tenant: ShopifyTokenTenant): Promise<ShopifyAccessResolution> {
  return resolveShopifyAccessForTenant(tenant, { skewMs: SHOPIFY_TOKEN_JOB_SKEW_MS });
}

/**
 * Lo que un job le pasa a `createShopifyClient` (D29, revisión). Con un
 * token legacy es el string de siempre: el cliente queda byte a byte como
 * antes y no hay ni una lectura extra de base. Con un token expirable es un
 * proveedor que en cada request RELEE la fila del tenant (ve rotaciones de
 * la web o de otro proceso, y hace su propio UPDATE condicional si le toca
 * renovar) y devuelve el access vigente; con `forceRefresh` (el reintento
 * por 401 del cliente GraphQL) rota aunque no esté por vencer. Si no hay
 * token usable tira con el mensaje accionable, que es lo que el job
 * termina escribiendo en el log del pedido.
 */
export function shopifyTokenSourceForTenant(tenantId: string, initial: ShopifyAccessResolution): ShopifyTokenSource {
  if (initial.access === null) throw new Error(initial.message);
  if (initial.legacy) return initial.access;
  const provider: ShopifyTokenProvider = async (opts) => {
    const row = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
    });
    if (!row) throw new Error('Shopify: el tenant ya no existe');
    const r = await resolveShopifyAccessForTenant(row, {
      skewMs: opts?.forceRefresh ? Number.POSITIVE_INFINITY : undefined,
    });
    if (r.access === null) throw new Error(r.message);
    return r.access;
  };
  return provider;
}
