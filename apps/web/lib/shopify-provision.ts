import { db } from '@/lib/db';
import { encrypt } from '@/lib/encryption';

/**
 * Alta de cuenta a partir de una instalación desde el Shopify App Store.
 *
 * EL PROBLEMA
 * -----------
 * Cuando alguien instala desde el App Store no tiene cuenta en AutoEnvía: llega
 * autorizado por Shopify y nada más. Si en ese momento le pedimos registrarse,
 * lo perdimos — ya hizo el esfuerzo de instalar y le respondemos con un
 * formulario.
 *
 * Así que la cuenta se crea sola con lo que Shopify ya nos dio, y al comerciante
 * se le manda un enlace para poner su contraseña. Entra a un producto que ya
 * está configurado, no a un formulario en blanco.
 *
 * IDEMPOTENCIA
 * ------------
 * Reinstalar es normal (el comerciante prueba, desinstala, vuelve). Todo acá se
 * apoya en dos claves estables:
 *   - `User.email`  → el email del dueño de la tienda que devuelve Shopify
 *   - `Tenant.slug` → derivado del dominio .myshopify.com, que no cambia nunca
 * Reinstalar reusa la misma cuenta y la misma tienda; no duplica ni pisa datos.
 */

export interface ShopInfo {
  email: string;
  name: string;
  domain: string;
}

/**
 * Datos de la tienda, para dar de alta la cuenta con algo real en vez de
 * inventar un nombre. Si Shopify no contesta, devolvemos null y el llamador
 * decide: es mejor no crear cuenta que crearla con basura.
 */
export async function fetchShopInfo(
  shop: string,
  accessToken: string,
  apiVersion = '2026-07',
): Promise<ShopInfo | null> {
  try {
    const resp = await fetch(`https://${shop}/admin/api/${apiVersion}/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { shop?: { email?: string; name?: string } };
    const email = (json.shop?.email ?? '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    return { email, name: (json.shop?.name ?? shop).trim() || shop, domain: shop };
  } catch {
    return null;
  }
}

/** `mi-tienda.myshopify.com` → `shop-mi-tienda`. Estable y único por tienda. */
export function tenantSlugForShop(shop: string): string {
  const handle = shop.split('.')[0].replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return `shop-${handle}`;
}

export type ProvisionOutcome =
  | { kind: 'created'; userId: string; tenantId: string; email: string }
  | { kind: 'existing'; userId: string; tenantId: string; email: string }
  /** La tienda ya está atada a otra cuenta: no la movemos por las buenas. */
  | { kind: 'conflict'; reason: 'shop_taken' };

/**
 * Deja la cuenta y la tienda listas para operar, y guarda el token cifrado.
 *
 * NO activa el tenant (`isActive` queda como está): el comerciante todavía
 * tiene que cargar sus credenciales de DAC para que el worker pueda despachar.
 * Activar acá le mostraría una cuenta "lista" que en realidad no puede hacer
 * nada, y el primer envío fallaría sin explicación.
 */
export async function provisionFromShopify(
  info: ShopInfo,
  accessToken: string,
): Promise<ProvisionOutcome> {
  const slug = tenantSlugForShop(info.domain);

  // ¿La tienda ya es de alguien? Si sí, no la reasignamos: dos cuentas
  // apuntando al mismo dominio hacen que el worker despache los mismos pedidos
  // dos veces.
  const existingByShop = await db.tenant.findFirst({
    where: { shopifyStoreUrl: info.domain },
    select: { id: true, userId: true, slug: true },
  });
  if (existingByShop && existingByShop.slug !== slug) {
    return { kind: 'conflict', reason: 'shop_taken' };
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: info.email },
      create: { email: info.email, name: info.name },
      update: {},
      select: { id: true },
    });

    const existing = await tx.tenant.findUnique({
      where: { slug },
      select: { id: true, userId: true },
    });

    if (existing) {
      // Reinstalación: refrescamos el token y nada más.
      if (existing.userId !== user.id) return { kind: 'conflict', reason: 'shop_taken' } as const;
      await tx.tenant.update({
        where: { id: existing.id },
        data: { shopifyStoreUrl: info.domain, shopifyToken: encrypt(accessToken) },
      });
      return { kind: 'existing', userId: user.id, tenantId: existing.id, email: info.email } as const;
    }

    const tenant = await tx.tenant.create({
      data: {
        userId: user.id,
        slug,
        name: info.name,
        shopifyStoreUrl: info.domain,
        shopifyToken: encrypt(accessToken),
      },
      select: { id: true },
    });

    return { kind: 'created', userId: user.id, tenantId: tenant.id, email: info.email } as const;
  });
}
