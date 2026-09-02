import crypto from 'crypto';
import type { AxiosError } from 'axios';
import logger from '../logger';

/**
 * Selector de API de Shopify por tenant (D27).
 *
 *   SHOPIFY_API_MODE=rest     → siempre REST 2024-01 (camino de hoy, byte a byte)
 *   SHOPIFY_API_MODE=graphql  → siempre GraphQL 2026-07
 *   SHOPIFY_API_MODE=auto     → (default) heurística:
 *       - slug EXACTAMENTE igual a `tenantSlugForShop(storeUrl)` (el slug
 *         determinista que crea el callback del App Store) → GraphQL. La app
 *         pública NO puede usar REST, así que no hay fallback en ese sentido.
 *         NO es un prefijo: `shop@marca.com` da un slug `shop-m1abcd` y una
 *         tienda adicional "Shop Marca" da `shop-marca-xxxxxx` (signup y
 *         tenants/route.ts derivan el slug del email/nombre + sufijo), y esos
 *         tenants tienen token de custom app: tienen que quedarse en REST.
 *       - cualquier otro slug (token de custom app pegado a mano) → REST.
 *         Sólo se conmuta a GraphQL si REST devuelve 403 con un cuerpo que
 *         diga POSITIVAMENTE que la app no puede usar la REST Admin API
 *         (`isRestForbiddenError`), y sólo si ese tenant nunca tuvo un 2xx
 *         REST en este proceso (`markRestWorking`): un tenant al que REST le
 *         respondió una vez no puede ser "app sin REST", así que cualquier
 *         403 posterior (scopes, pedidos de más de 60 días) sube tal cual.
 *
 * No hay columna en la base para el modo (sin migración): la memoria vive en
 * Maps del proceso y se pierde al reiniciar, que es lo que se quiere — el
 * próximo ciclo vuelve a probar REST y, si sigue prohibido, vuelve a conmutar.
 *
 * TEXTO EXACTO DEL 403 de la app pública: la doc de Shopify no lo publica y
 * `fetchShopInfo` tragaba el status, así que NO está verificado (PENDIENTES
 * tiene el curl). El patrón positivo de abajo es una inferencia; si el texto
 * real no matchea, el tenant con slug viejo y token de la app pública NO
 * conmuta y ve un 403 claro en el runlog (fallo visible, no degradación
 * silenciosa). Los tenants `shop-*` reales no dependen de esto.
 */

export type ShopifyApiMode = 'rest' | 'graphql';
export type ShopifyApiPolicy = ShopifyApiMode | 'auto';

export interface ShopifyApiContext {
  tenantId?: string | null;
  slug?: string | null;
  /** Dominio myshopify del tenant; también es la clave de memo cuando no hay tenantId (p.ej. tests). */
  storeUrl?: string | null;
}

/** tenantId (o storeUrl) → motivo por el que REST quedó prohibido. */
const restForbidden = new Map<string, string>();
/** tenantId (o storeUrl) de los tenants a los que REST ya les respondió 2xx en este proceso. */
const restWorking = new Set<string>();

/**
 * Cuerpos de 403 que NO son "app sin REST" y nunca conmutan:
 *   - `required permission(s)`: scopes faltantes; fulfillment.ts lo traduce a
 *     ShopifyMissingScopesError y en GraphQL fallaría igual y peor explicado.
 *   - `merchant approval for read_orders scope` / `read_all_orders` (pedidos
 *     de más de 60 días): visto en community.shopify.com (hilo 24159) con
 *     token de custom app que SÍ puede usar REST.
 */
const REST_403_NEVER_SWITCH = [/required permission/i, /merchant approval/i];

/**
 * Cuerpos de 403 que sí significan "esta app no puede usar la REST Admin API".
 * Match POSITIVO: un 403 que no diga esto no conmuta. INFERIDO, no
 * verificado contra la respuesta real (ver cabecera y PENDIENTES.md).
 */
const REST_403_FORBIDDEN_PATTERNS = [/REST Admin API/i];

export function getShopifyApiPolicy(): ShopifyApiPolicy {
  const raw = (process.env.SHOPIFY_API_MODE ?? 'auto').trim().toLowerCase();
  if (raw === 'rest' || raw === 'graphql') return raw;
  if (raw !== 'auto' && raw !== '') {
    logger.warn({ SHOPIFY_API_MODE: raw }, 'SHOPIFY_API_MODE desconocido, usando auto');
  }
  return 'auto';
}

/**
 * Réplica exacta de `tenantSlugForShop` en apps/web/lib/shopify-provision.ts
 * (misma regla: handle ≤ 40 → `shop-<handle>`; más largo → `shop-<31 primeros>-<sha256[0:8] del handle completo>`).
 * Si cambia allá tiene que cambiar acá: hay test con vectores fijos.
 */
export function tenantSlugForShop(shop: string): string {
  const handle = shop.split('.')[0].replace(/[^a-z0-9-]/g, '');
  if (handle.length <= 40) return `shop-${handle}`;
  const hash = crypto.createHash('sha256').update(handle).digest('hex').slice(0, 8);
  return `shop-${handle.slice(0, 31)}-${hash}`;
}

/** Tenant creado por el callback del App Store: el slug es letra por letra el determinista de su tienda. */
export function isAppStoreSlug(slug: string | null | undefined, storeUrl: string | null | undefined): boolean {
  if (typeof slug !== 'string' || typeof storeUrl !== 'string' || !storeUrl) return false;
  return slug === tenantSlugForShop(storeUrl);
}

function memoKey(ctx: ShopifyApiContext): string | null {
  return ctx.tenantId ?? ctx.storeUrl ?? null;
}

export function resolveShopifyApi(ctx: ShopifyApiContext): ShopifyApiMode {
  const policy = getShopifyApiPolicy();
  if (policy !== 'auto') return policy;
  if (isAppStoreSlug(ctx.slug, ctx.storeUrl)) return 'graphql';
  const key = memoKey(ctx);
  if (key && restForbidden.has(key)) return 'graphql';
  return 'rest';
}

/** REST respondió 2xx a este tenant: desde acá ningún 403 lo conmuta (en este proceso). */
export function markRestWorking(ctx: ShopifyApiContext): void {
  const key = memoKey(ctx);
  if (key) restWorking.add(key);
}

export function isRestKnownWorking(ctx: ShopifyApiContext): boolean {
  const key = memoKey(ctx);
  return !!key && restWorking.has(key);
}

export function markRestForbidden(ctx: ShopifyApiContext, reason: string): void {
  const key = memoKey(ctx);
  if (!key) return;
  if (!restForbidden.has(key)) {
    logger.warn(
      { tenantId: ctx.tenantId ?? null, slug: ctx.slug ?? null, reason: reason.slice(0, 200) },
      'Shopify REST rechazado con 403 (app sin REST): este tenant pasa a GraphQL hasta reiniciar el worker',
    );
  }
  restForbidden.set(key, reason.slice(0, 200));
}

export function isRestForbiddenFor(ctx: ShopifyApiContext): boolean {
  const key = memoKey(ctx);
  return !!key && restForbidden.has(key);
}

/**
 * ¿Este error de axios significa "la app no puede usar REST"? Sólo un 403
 * cuyo cuerpo matchee POSITIVAMENTE `REST_403_FORBIDDEN_PATTERNS` y no
 * matchee ninguno de `REST_403_NEVER_SWITCH`. Cualquier otro 403 (scopes,
 * `merchant approval`, `Forbidden` pelado, tienda marcada) devuelve null y
 * el error sube tal cual.
 */
export function isRestForbiddenError(err: unknown): { body: string } | null {
  const ae = err as AxiosError | undefined;
  if (!ae || typeof ae !== 'object' || !ae.isAxiosError) return null;
  if (ae.response?.status !== 403) return null;
  const data = ae.response.data;
  const body = typeof data === 'string' ? data : JSON.stringify(data ?? {});
  if (REST_403_NEVER_SWITCH.some((re) => re.test(body))) return null;
  if (!REST_403_FORBIDDEN_PATTERNS.some((re) => re.test(body))) return null;
  return { body };
}

/** Sólo para tests. */
export function _resetShopifyApiMemo(): void {
  restForbidden.clear();
  restWorking.clear();
}
