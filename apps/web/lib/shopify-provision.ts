import crypto from 'crypto';
import { db } from '@/lib/db';
import { encrypt } from '@/lib/encryption';
import { nuevoTenantBase } from '@/lib/tenant-provision';
import { shopifyGraphql, SHOPIFY_GRAPHQL_API_VERSION } from '@/lib/shopify-graphql';

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
 * QUIÉN ES EL DUEÑO — LA REGLA QUE NO SE NEGOCIA (D11)
 * -----------------------------------------------------
 * `shop.email` es el email de contacto de la tienda: lo edita el comerciante y
 * Shopify NO lo verifica como identidad. Si con ese email existiera ya un User
 * nuestro, colgarle la tienda automáticamente sería regalarle a cualquiera la
 * posibilidad de meter una tienda ajena dentro de la cuenta de un cliente (o,
 * el caso más común, dejar la tienda del comerciante bajo la cuenta de la
 * agencia que le administra el admin). Por eso:
 *
 *   - tienda nueva + email SIN cuenta  → creamos User + Tenant ('created')
 *   - tienda nueva + email CON cuenta  → NO tocamos nada ('claim'): el dueño
 *     de esa cuenta tiene que loguearse y reclamar la tienda él mismo.
 *   - tienda ya vinculada al User de ese email → refrescamos el token ('existing')
 *   - tienda ya vinculada a otro User          → 'conflict', no se mueve
 *
 * IDEMPOTENCIA
 * ------------
 * Reinstalar es normal (el comerciante prueba, desinstala, vuelve). Todo acá se
 * apoya en dos claves estables:
 *   - `Tenant.shopifyStoreUrl` → el dominio .myshopify.com, que no cambia nunca
 *   - `Tenant.slug`            → derivado de ese dominio
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
 *
 * GraphQL, no REST (D27): la app pública fue creada después del 1/4/2025 y
 * Shopify le niega el REST Admin API — el primer install real en
 * autoenvia-qa murió acá con `shop_info_failed`. Campos verificados en
 * objects/Shop 2026-07: `name`, `email` (no deprecado), `myshopifyDomain`.
 */
export const SHOP_INFO_QUERY = `query LabelFlowShopInfo {
  shop {
    name
    email
    myshopifyDomain
  }
}`;

export async function fetchShopInfo(
  shop: string,
  accessToken: string,
  apiVersion = SHOPIFY_GRAPHQL_API_VERSION,
): Promise<ShopInfo | null> {
  try {
    const res = await shopifyGraphql<{ shop?: { name?: string | null; email?: string | null; myshopifyDomain?: string | null } }>(
      shop,
      accessToken,
      SHOP_INFO_QUERY,
      {},
      { apiVersion },
    );
    if (res.status !== 200 || !res.data?.shop) {
      // Sin token en el log: sólo tienda, status y códigos de error.
      console.warn('[shopify/provision] shop info failed', {
        shop,
        status: res.status,
        codes: res.errors.map((e) => e.extensions?.code ?? 'unknown'),
      });
      return null;
    }
    const email = (res.data.shop.email ?? '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    return { email, name: (res.data.shop.name ?? shop).trim() || shop, domain: shop };
  } catch {
    return null;
  }
}

/**
 * `mi-tienda.myshopify.com` → `shop-mi-tienda`. Estable y único por tienda.
 *
 * Handles de hasta 40 caracteres se usan tal cual. Más largos: se toman los
 * primeros 31 y se les pega un hash corto del handle COMPLETO, así dos tiendas
 * que comparten el prefijo no colisionan en el slug (antes se truncaba a 40 y
 * la segunda caía en 'shop_taken' sin explicación). Tope: 5 + 31 + 1 + 8 = 45.
 */
export function tenantSlugForShop(shop: string): string {
  const handle = shop.split('.')[0].replace(/[^a-z0-9-]/g, '');
  if (handle.length <= 40) return `shop-${handle}`;
  const hash = crypto.createHash('sha256').update(handle).digest('hex').slice(0, 8);
  return `shop-${handle.slice(0, 31)}-${hash}`;
}

export type ProvisionOutcome =
  | { kind: 'created'; userId: string; tenantId: string; email: string }
  | { kind: 'existing'; userId: string; tenantId: string; email: string }
  /** Ya hay una cuenta con ese email: no se crea nada, el dueño tiene que reclamarla logueado. */
  | { kind: 'claim'; email: string }
  /** La tienda ya está atada a otra cuenta: no la movemos por las buenas. */
  | { kind: 'conflict'; reason: 'shop_taken' };

/**
 * Deja la cuenta y la tienda listas para operar, y guarda el token cifrado.
 *
 * Todo corre dentro de UNA transacción, incluido el chequeo de "¿la tienda ya
 * es de alguien?": dos callbacks simultáneos para el mismo shop no pueden
 * pasar los dos, y si igual chocan en el índice único del SLUG (P2002; el
 * dominio no tiene índice único todavía, ver D18 y D22) se devuelve 'conflict' en
 * vez de un 500 que Shopify muestra como "instalación fallida".
 *
 * NO activa el tenant (`isActive` queda como está): el comerciante todavía
 * tiene que cargar sus credenciales de DAC para que el worker pueda despachar.
 * Activar acá le mostraría una cuenta "lista" que en realidad no puede hacer
 * nada, y el primer envío fallaría sin explicación.
 *
 * `tosAcceptedAt` queda en null a propósito: el comerciante autorizó la app en
 * Shopify, no aceptó NUESTROS términos. Ningún gate del código lo exige hoy;
 * la aceptación en el primer login está en PENDIENTES.md.
 */
export async function provisionFromShopify(
  info: ShopInfo,
  accessToken: string,
): Promise<ProvisionOutcome> {
  const slug = tenantSlugForShop(info.domain);

  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { email: info.email },
        select: { id: true },
      });

      // Insensible a mayúsculas: los tenants cargados a mano pueden tener el
      // dominio con mayúsculas y `info.domain` viene normalizado (D18).
      const existingByShop = await tx.tenant.findFirst({
        where: { shopifyStoreUrl: { equals: info.domain, mode: 'insensitive' } },
        select: { id: true, userId: true },
      });

      if (existingByShop) {
        // La tienda ya es de alguien. Sólo si ese alguien es el User del email
        // de la tienda se trata de una reinstalación: refrescamos el token.
        if (!user || existingByShop.userId !== user.id) {
          return { kind: 'conflict', reason: 'shop_taken' } as const;
        }
        await tx.tenant.update({
          where: { id: existingByShop.id },
          data: { shopifyToken: encrypt(accessToken) },
        });
        return { kind: 'existing', userId: user.id, tenantId: existingByShop.id, email: info.email } as const;
      }

      // Tienda nueva. Si ya hay cuenta con ese email, NO se le cuelga nada:
      // que entre y la reclame (ver cabecera).
      if (user) {
        return { kind: 'claim', email: info.email } as const;
      }

      const base = await nuevoTenantBase(tx, slug);
      const created = await tx.user.create({
        data: {
          email: info.email,
          name: info.name,
          tenants: {
            create: [
              {
                slug,
                name: info.name,
                shopifyStoreUrl: info.domain,
                shopifyToken: encrypt(accessToken),
                apiKey: base.apiKey,
                referralCode: base.referralCode,
              },
            ],
          },
        },
        select: { id: true, tenants: { select: { id: true }, take: 1 } },
      });

      return {
        kind: 'created',
        userId: created.id,
        tenantId: created.tenants[0].id,
        email: info.email,
      } as const;
    });
  } catch (err) {
    // Carrera perdida contra otro callback (slug, email o referralCode ya
    // tomados entre el chequeo y el insert). Es un conflicto, no un error.
    if ((err as { code?: string }).code === 'P2002') {
      return { kind: 'conflict', reason: 'shop_taken' };
    }
    throw err;
  }
}
