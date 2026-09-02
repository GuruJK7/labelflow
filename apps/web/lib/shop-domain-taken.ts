import { db } from './db';

/**
 * Un dominio de Shopify pertenece a UN tenant. Este es el chequeo que comparten
 * las cuatro puertas por las que entra una tienda — `/api/shopify/install`,
 * `/api/shopify/claim`, `PUT /api/v1/settings` y el paso 2 del onboarding por
 * token manual (`onboarding/test-shopify`) — para que ninguna quede más floja
 * que las otras. Sin él, una cuenta nueva podía pegar el token de una tienda
 * que ya es de otro usuario: cobraba el trial otra vez sobre la misma tienda y
 * el worker despachaba cada pedido dos veces (D21, D31, revisión 2026-09-02).
 *
 * Insensible a mayúsculas por los dominios viejos guardados así (D18) y
 * excluyendo al propio tenant.
 */
export const SHOP_DOMAIN_TAKEN_MESSAGE =
  'Esa tienda ya está conectada a otra cuenta. Escribinos y lo resolvemos.';

export async function shopDomainTakenByOtherTenant(shop: string, ownTenantId: string): Promise<boolean> {
  const tomada = await db.tenant.findFirst({
    where: {
      shopifyStoreUrl: { equals: shop, mode: 'insensitive' },
      id: { not: ownTenantId },
    },
    select: { id: true },
  });
  return !!tomada;
}

/**
 * Regla completa de D21: el conflicto se busca SÓLO cuando el dominio CAMBIA
 * respecto del guardado. Hay tenants que comparten tienda a propósito (el
 * worker lo contempla con `sharedTenantIds`; incidente Aura 2026-05-08):
 * chequear también cuando el dominio no se tocó les cerraba la única forma de
 * rotar el token, porque /install y /callback ya les dan already_linked.
 */
export async function shopDomainChangeConflicts(shop: string, ownTenantId: string): Promise<boolean> {
  const actual = await db.tenant.findUnique({
    where: { id: ownTenantId },
    select: { shopifyStoreUrl: true },
  });
  const sinCambio = actual?.shopifyStoreUrl?.toLowerCase() === shop;
  if (sinCambio) return false;
  return shopDomainTakenByOtherTenant(shop, ownTenantId);
}
