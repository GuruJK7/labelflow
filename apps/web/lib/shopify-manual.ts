/**
 * Requisito 2.3.1 del App Store de Shopify, textual:
 *
 *   «Apps must be installed and initiated only on Shopify services. Your app
 *    must not request the manual entry of a myshopify.com URL or a shop's
 *    domain during the installation or configuration flow.»
 *
 * La app tenía DOS caminos manuales que lo violaban de frente:
 *
 *   1. Un input `mitienda.myshopify.com` en el paso 2 del wizard y en
 *      Configuración → Shopify.
 *   2. Un campo para pegar un Admin API access token (`shpat_…`), que además
 *      empuja al comerciante a crearse una app privada — justo el flujo que
 *      2.3.1 viene a matar.
 *
 * Los dos existían por razones legítimas y anteriores a la app pública: así se
 * conectaban las tiendas antes de que existiera OAuth, y los tenants viejos se
 * dieron de alta por ahí. Pero hoy el camino bueno es que Shopify nos mande el
 * `shop` firmado a `/api/shopify/entry`, y el comerciante que llega a
 * autoenvia.com por su cuenta tiene que ir al App Store a instalar.
 *
 * NO se borra el código: el backend (`/api/shopify/install`, el alta por token)
 * sigue funcionando igual, porque hay tenants en producción que dependen de él
 * y porque borrarlo sería un cambio de comportamiento, no de presentación. Lo
 * que se apaga es la UI que lo OFRECE, que es lo que el revisor ve y lo que la
 * regla prohíbe.
 *
 * Para volver a prenderlo (soporte, debug, un comerciante trabado):
 *   NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY=true
 * En producción va apagada. Al no estar seteada, queda apagada sola: es
 * fail-closed, que es lo que corresponde cuando lo que se arriesga es el
 * rechazo de la app.
 */
export const MANUAL_SHOPIFY_ENABLED =
  process.env.NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY === 'true';

/**
 * ¿Se le puede ofrecer a ESTE usuario el camino manual?
 *
 * 🔴 EL PROBLEMA QUE ESTO RESUELVE (05-09-2026). Apagar la UI manual dejó al
 * dueño de AutoEnvía sin forma de conectar una tienda Shopify: el único camino
 * que queda es «instalá desde el App Store», y la app todavía está EN REVISIÓN,
 * así que `NEXT_PUBLIC_SHOPIFY_APP_STORE_URL` no existe y la tarjeta del paso 2
 * termina en un texto que no lleva a ningún lado. Alta imposible.
 *
 * Prender `NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY` en producción resolvería el alta y
 * rompería justo lo que se está cuidando: el revisor de Shopify entra a
 * autoenvia.com como un comerciante cualquiera y vería el input de dominio y el
 * campo del token — que es textualmente lo que 2.3.1 prohíbe.
 *
 * La salida es que el camino manual dependa de QUIÉN mira, no sólo de una env
 * var global. Un admin (`ADMIN_EMAILS`) lo ve siempre; cualquier otro
 * —incluido el revisor, que se registra como un comerciante más— sigue viendo
 * exactamente lo que veía antes de este cambio. La regla que se está cumpliendo
 * es sobre el flujo de instalación que se le OFRECE a un comerciante, y un
 * admin operando su propio panel no es ese flujo.
 *
 * Sigue siendo fail-closed: sin flag y sin admin, apagado.
 */
export function puedeConectarShopifyAMano(esAdmin: boolean | undefined): boolean {
  return MANUAL_SHOPIFY_ENABLED || esAdmin === true;
}
