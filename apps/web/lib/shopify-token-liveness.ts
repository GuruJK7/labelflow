import { resolveShopifyAccessForTenant } from '@/lib/shopify-access';
import { shopifyGraphql } from '@/lib/shopify-graphql';
import type { ShopifyTokenTenant } from '@/lib/shopify-token';

/**
 * ¿El token de Shopify que tenemos guardado sigue VIVO?
 *
 * 🔴 POR QUÉ EXISTE. `/api/shopify/entry` decidía "esta tienda ya está
 * conectada" mirando si `shopifyToken` era distinto de null. Pero lo único
 * en todo el repo que pone ese token en null es el webhook `app/uninstalled`,
 * y ese webhook es best-effort: si no llegó (registro fallido en el install,
 * carrera con una reinstalación inmediata, Shopify que no lo entregó), el
 * token queda escrito en la base aunque Shopify ya lo revocó.
 *
 * El modo de fallo era el peor para una revisión del App Store: el revisor
 * desinstala y reinstala —está probado que lo hace: Style with Passion instaló
 * 11:52 y desinstaló 12:00 el 14-09; appstoretest4 lo mismo el 03-09— y
 * `/entry` lo mandaba a `/login?shopify=open` sin arrancar OAuth nunca más.
 * La tienda quedaba instalada en Shopify y muerta en AutoEnvía.
 *
 * QUÉ HACE. Resuelve el token (renovándolo si hace falta, igual que el resto
 * de la app) y le pregunta a Shopify algo mínimo que no exige ningún scope:
 * `shop { id }`. Tres respuestas posibles, y la distinción importa:
 *
 *   - `viva`          → Shopify contestó 200: la tienda sigue conectada.
 *   - `muerta`        → 401 o 403 (token revocado: la app se desinstaló), o
 *                       la renovación dio `invalid_grant`, o no hay token
 *                       usable. Hay que volver a pedir OAuth.
 *   - `indeterminada` → 5xx, 429, timeout, red: NO se sabe. Se trata como
 *                       viva a propósito (ver abajo).
 *
 * POR QUÉ `indeterminada` NO REINICIA OAUTH. Es la elección conservadora: ante
 * un hipo de Shopify se conserva exactamente el comportamiento de hoy (mandar
 * al login), que como mucho retrasa una reinstalación hasta el próximo
 * intento. Lo contrario —reiniciar OAuth en cada apertura durante una caída de
 * Shopify— dispararía el callback, el refresco del token y el registro de
 * webhooks en cada apertura, que es lo que D12 quiso evitar desde el principio.
 */
export type VitalidadDelToken = 'viva' | 'muerta' | 'indeterminada';

/** Lo más chico que se le puede preguntar a Shopify: no pide ningún scope. */
export const SHOP_PING_QUERY = `query AutoEnviaPing { shop { id } }`;

/** Un ping no puede colgar la instalación: si Shopify tarda, es indeterminado. */
export const PING_TIMEOUT_MS = 6_000;

/**
 * Traduce lo que devolvió el ping a una vitalidad. Es puro para poder
 * testearlo contra cada status sin red.
 */
export function vitalidadSegunPing(status: number, hayShop: boolean): VitalidadDelToken {
  if (status === 200 && hayShop) return 'viva';
  // 401: «Invalid API key or access token» — el token fue revocado.
  // 403: la app no está autorizada en esa tienda (visto en autoenvia-qa el
  //      tercer install: 403 sin códigos).
  if (status === 401 || status === 403) return 'muerta';
  return 'indeterminada';
}

export async function vitalidadDelToken(tenant: ShopifyTokenTenant, shop: string): Promise<VitalidadDelToken> {
  const r = await resolveShopifyAccessForTenant(tenant);
  if (!r.access) {
    // `refresh-failed` es un fallo transitorio al renovar: no dice nada del
    // token. Todo lo demás (`reinstall` = invalid_grant, `no-token`,
    // `unreadable`) significa que con lo guardado no se puede operar.
    return r.reason === 'refresh-failed' ? 'indeterminada' : 'muerta';
  }
  try {
    const res = await shopifyGraphql<{ shop?: { id?: string } | null }>(shop, r.access, SHOP_PING_QUERY, {}, {
      timeoutMs: PING_TIMEOUT_MS,
    });
    return vitalidadSegunPing(res.status, Boolean(res.data?.shop?.id));
  } catch {
    return 'indeterminada';
  }
}
