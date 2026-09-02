import type { AxiosError } from 'axios';
import logger from '../logger';

/**
 * Selector de API de Shopify por tenant (D27).
 *
 *   SHOPIFY_API_MODE=rest     → siempre REST 2024-01 (camino de hoy, byte a byte)
 *   SHOPIFY_API_MODE=graphql  → siempre GraphQL 2026-07
 *   SHOPIFY_API_MODE=auto     → (default) heurística:
 *       - slug `shop-<handle>` (tenant creado por el App Store, ver
 *         `tenantSlugForShop` en apps/web) → GraphQL. La app pública NO puede
 *         usar REST, así que no hay fallback en ese sentido.
 *       - cualquier otro slug (token de custom app pegado a mano) → REST.
 *         Si REST devuelve 403 sin el texto de "required permission" (que es
 *         el caso de scopes faltantes y ya tiene su error tipado), se asume
 *         "esta app no puede usar REST", se memoriza por tenant en memoria
 *         del proceso y se pasa a GraphQL para ese tenant hasta reiniciar.
 *
 * No hay columna en la base para el modo (sin migración): la memoria vive en
 * un Map del proceso y se pierde al reiniciar, que es lo que se quiere — el
 * próximo ciclo vuelve a probar REST y, si sigue prohibido, vuelve a conmutar.
 *
 * TEXTO EXACTO DEL 403: la doc de Shopify no lo publica y `fetchShopInfo`
 * tragaba el status, así que no se conoce. Regla: 403 en un endpoint de
 * pedidos/tienda con token válido y sin `required permission` en el cuerpo.
 */

export type ShopifyApiMode = 'rest' | 'graphql';
export type ShopifyApiPolicy = ShopifyApiMode | 'auto';

export interface ShopifyApiContext {
  tenantId?: string | null;
  slug?: string | null;
  /** Fallback de clave de memo cuando no hay tenantId (p.ej. tests). */
  storeUrl?: string | null;
}

const APP_STORE_SLUG_PREFIX = 'shop-';

/** tenantId (o storeUrl) → motivo por el que REST quedó prohibido. */
const restForbidden = new Map<string, string>();

export function getShopifyApiPolicy(): ShopifyApiPolicy {
  const raw = (process.env.SHOPIFY_API_MODE ?? 'auto').trim().toLowerCase();
  if (raw === 'rest' || raw === 'graphql') return raw;
  if (raw !== 'auto' && raw !== '') {
    logger.warn({ SHOPIFY_API_MODE: raw }, 'SHOPIFY_API_MODE desconocido, usando auto');
  }
  return 'auto';
}

export function isAppStoreSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.startsWith(APP_STORE_SLUG_PREFIX);
}

function memoKey(ctx: ShopifyApiContext): string | null {
  return ctx.tenantId ?? ctx.storeUrl ?? null;
}

export function resolveShopifyApi(ctx: ShopifyApiContext): ShopifyApiMode {
  const policy = getShopifyApiPolicy();
  if (policy !== 'auto') return policy;
  if (isAppStoreSlug(ctx.slug)) return 'graphql';
  const key = memoKey(ctx);
  if (key && restForbidden.has(key)) return 'graphql';
  return 'rest';
}

export function markRestForbidden(ctx: ShopifyApiContext, reason: string): void {
  const key = memoKey(ctx);
  if (!key) return;
  if (!restForbidden.has(key)) {
    logger.warn(
      { tenantId: ctx.tenantId ?? null, slug: ctx.slug ?? null, reason: reason.slice(0, 200) },
      'Shopify REST rechazado con 403: este tenant pasa a GraphQL hasta reiniciar el worker',
    );
  }
  restForbidden.set(key, reason.slice(0, 200));
}

export function isRestForbiddenFor(ctx: ShopifyApiContext): boolean {
  const key = memoKey(ctx);
  return !!key && restForbidden.has(key);
}

/**
 * ¿Este error de axios significa "la app no puede usar REST"? 403 sin
 * `required permission` (eso es scopes faltantes: fulfillment.ts ya lo
 * traduce a ShopifyMissingScopesError y NO debe conmutar de API, porque en
 * GraphQL fallaría igual y peor explicado).
 */
export function isRestForbiddenError(err: unknown): { body: string } | null {
  const ae = err as AxiosError | undefined;
  if (!ae || typeof ae !== 'object' || !ae.isAxiosError) return null;
  if (ae.response?.status !== 403) return null;
  const data = ae.response.data;
  const body = typeof data === 'string' ? data : JSON.stringify(data ?? {});
  if (/required permission/i.test(body)) return null;
  return { body };
}

/** Sólo para tests. */
export function _resetShopifyApiMemo(): void {
  restForbidden.clear();
}
