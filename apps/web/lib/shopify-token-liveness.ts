import { resolveShopifyAccessForTenant } from '@/lib/shopify-access';
import { shopifyGraphql } from '@/lib/shopify-graphql';
import { decryptIfPresent } from '@/lib/encryption';
import { parseShopifyCredential, type ShopifyTokenTenant } from '@/lib/shopify-token';

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
 * QUÉ HACE. Le pregunta a Shopify algo mínimo que no exige ningún scope:
 * `shop { id }`. Tres respuestas posibles, y la distinción importa:
 *
 *   - `viva`          → Shopify contestó 200: la tienda sigue conectada.
 *   - `muerta`        → Shopify dijo que no: 401/403 al ping, o el refresh
 *                       fue terminal. Hay que volver a pedir OAuth.
 *   - `indeterminada` → no se pudo saber (5xx, 429, timeout, red, o el token
 *                       guardado no se puede leer). Se trata como viva.
 *
 * 🔴 LA REGLA QUE ORDENA TODO: EL TOKEN SÓLO SE DA POR MUERTO CON EVIDENCIA
 * DE SHOPIFY. Nunca por un fallo nuestro. Un token que no descifra (clave de
 * cifrado mal puesta en un deploy) es `indeterminada`, no `muerta`: borrarlo
 * convertiría un error de configuración —que se arregla poniendo la clave—
 * en pérdida de credenciales, y para un token legacy pegado a mano eso es
 * pedírselo de nuevo al cliente. shopify-token.ts lo fija como invariante
 * («NO se borra el token») y esto lo respeta.
 *
 * CÓMO SE CONSIGUE EL ACCESS PARA PINGUEAR. Primero por el resolvedor
 * normal (renueva si hace falta). Si la renovación falló pero NO fue
 * terminal, se pinguea igual con el access GUARDADO aunque esté vencido:
 * un token revocado da 401 y uno vencido de una app todavía instalada
 * también da 401 → `muerta` → OAuth → el callback escribe un par nuevo. Es
 * una re-autorización, no un loop: la apertura siguiente ya pinguea 200.
 * Sin esto, el diagnóstico dependía de clasificar bien el cuerpo del error
 * del refresh, que fue exactamente lo que falló la primera vez.
 *
 * POR QUÉ `indeterminada` NO REINICIA OAUTH. Ante un hipo de Shopify se
 * conserva exactamente el comportamiento de hoy (mandar al login), que como
 * mucho retrasa una reinstalación hasta el próximo intento. Lo contrario
 * dispararía el callback, el refresco y el registro de webhooks en cada
 * apertura durante una caída, que es lo que D12 quiso evitar.
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
  // 401: «Invalid API key or access token» — el token fue revocado o venció.
  // 403: la app no está autorizada en esa tienda (visto en autoenvia-qa el
  //      tercer install: 403 sin códigos).
  if (status === 401 || status === 403) return 'muerta';
  return 'indeterminada';
}

async function ping(shop: string, access: string): Promise<VitalidadDelToken> {
  try {
    const res = await shopifyGraphql<{ shop?: { id?: string } | null }>(shop, access, SHOP_PING_QUERY, {}, {
      timeoutMs: PING_TIMEOUT_MS,
    });
    return vitalidadSegunPing(res.status, Boolean(res.data?.shop?.id));
  } catch {
    return 'indeterminada';
  }
}

export async function vitalidadDelToken(tenant: ShopifyTokenTenant, shop: string): Promise<VitalidadDelToken> {
  let resuelto: Awaited<ReturnType<typeof resolveShopifyAccessForTenant>> | null = null;
  try {
    resuelto = await resolveShopifyAccessForTenant(tenant);
  } catch {
    // Un fallo del resolvedor (base, cifrado) no es evidencia sobre el token.
    resuelto = null;
  }

  if (resuelto?.access) return ping(shop, resuelto.access);

  // El refresh fue terminal: Shopify mismo dijo que ese par ya no sirve.
  if (resuelto?.reason === 'reinstall') return 'muerta';

  // No se pudo renovar (o el resolvedor tiró): que decida Shopify con el
  // access guardado, vencido o no. Sólo si es legible.
  if (resuelto === null || resuelto.reason === 'refresh-failed') {
    const guardado = parseShopifyCredential(decryptIfPresent(tenant.shopifyToken))?.access;
    if (guardado) return ping(shop, guardado);
  }

  // `unreadable` / `no-token`: evidencia local. No se toca nada.
  return 'indeterminada';
}
