import { getControlActor } from './control-scope';
import { puedeConectarShopifyAMano } from './shopify-manual';

/**
 * Mitad de servidor del requisito 2.3.1 (16-09-2026).
 *
 * `lib/shopify-manual.ts` decide si se le OFRECE el alta manual a quien mira;
 * lo importan componentes de cliente, así que no puede tocar la base ni la
 * sesión. Este módulo es la otra mitad: decide si el backend ACEPTA que
 * alguien escriba un dominio `.myshopify.com` o un Admin API token a mano.
 *
 * 🔴 POR QUÉ HACÍA FALTA. Apagar la UI no cerraba nada: `POST
 * /api/v1/onboarding/test-shopify` y `PUT /api/v1/settings` seguían tomando
 * `shopifyStoreUrl` / `shopifyToken` de cualquier tenant logueado. Un revisor
 * de Shopify con sesión —que es exactamente el escenario del rechazo— podía
 * dar de alta una tienda por el camino que 2.3.1 prohíbe, sin pasar nunca por
 * una superficie de Shopify.
 *
 * QUÉ **NO** GATEA, Y ES DELIBERADO. Esto corre sólo cuando el request trae un
 * dominio o un token NUEVO. Los tenants que ya tienen token cargado (Kinevia,
 * TAM, Aura, Enerva y todo el resto del alta vieja) siguen despachando igual:
 * leer, usar y rotar-por-OAuth el token que ya existe no pasa por acá. El
 * camino bueno tampoco: `/api/shopify/callback` escribe el token directo
 * después del OAuth, no por estas dos rutas.
 *
 * Fail-closed: si no se puede resolver quién llama (base caída, sesión rara),
 * la respuesta es NO. Lo que se arriesga al equivocarse para el otro lado es
 * el rechazo de la app.
 */
export async function puedeEscribirShopifyAMano(): Promise<boolean> {
  try {
    const actor = await getControlActor();
    return puedeConectarShopifyAMano(actor?.isAdmin === true);
  } catch {
    return false;
  }
}

/**
 * Lo que ve quien intenta el alta manual sin ser admin. No menciona que exista
 * un camino manual ni a dónde ir a buscarlo: el único camino que se nombra es
 * el que la regla exige.
 */
export const SHOPIFY_MANUAL_BLOQUEADO_MESSAGE =
  'La tienda se conecta instalando AutoEnvía desde el App Store de Shopify.';
