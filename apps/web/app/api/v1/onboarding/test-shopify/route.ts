import { z } from 'zod';
import { db } from '@/lib/db';
import {
  getAuthenticatedTenant,
  apiError,
  apiSuccess,
} from '@/lib/api-utils';
import { encrypt } from '@/lib/encryption';
import { shopDomainChangeConflicts, SHOP_DOMAIN_TAKEN_MESSAGE } from '@/lib/shop-domain-taken';
import { shopifyGraphql } from '@/lib/shopify-graphql';
import { SHOP_INFO_QUERY } from '@/lib/shopify-provision';
import { REQUIRED_SCOPES } from '@/lib/shopify-oauth';
import {
  puedeEscribirShopifyAMano,
  SHOPIFY_MANUAL_BLOQUEADO_MESSAGE,
} from '@/lib/shopify-manual.server';

/**
 * POST /api/v1/onboarding/test-shopify
 *
 * Verifies the user-supplied Shopify URL + token with a `shop` query contra el
 * Admin **GraphQL** API. On success, persists both fields (token encrypted).
 *
 * Used by the onboarding wizard's Shopify step to give the user immediate,
 * trustable feedback ("Conexión OK ✓ — tu tienda 'XYZ'") before letting them
 * advance. Reusing the same logic as PUT /api/v1/settings (line 209-223 of
 * settings/route.ts) means a future schema change to either side has one
 * place to update — but we run it as a separate endpoint so the onboarding
 * UI can call it without triggering the full settings PUT side-effects
 * (DAC cookie invalidation, isActive cascades).
 *
 * Antes de hablar con Shopify rechaza (409) un dominio que ya es de OTRO
 * tenant, igual que /install, /claim y settings PUT (lib/shop-domain-taken):
 * si no, una cuenta nueva podía pegar el token de una tienda ajena, cobrarse
 * el trial otra vez sobre la misma tienda y duplicar despachos.
 */
const bodySchema = z.object({
  shopifyStoreUrl: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/,
      'Debe ser un dominio Shopify válido (ej: tu-tienda.myshopify.com)',
    )
    // En minúsculas, como lo manda Shopify: el flujo del App Store busca por
    // dominio y un dominio con mayúsculas no se encontraba (D18).
    .transform((s) => s.toLowerCase()),
  shopifyToken: z.string().min(10).max(512),
});

/** Sólo se usa `name`; los otros campos vienen en SHOP_INFO_QUERY. */
interface ShopProbeData {
  shop?: { name?: string | null; email?: string | null; myshopifyDomain?: string | null } | null;
}

/** Códigos de `errors[].extensions.code` que significan "el token no sirve". */
const AUTH_ERROR_CODES = new Set(['ACCESS_DENIED', 'UNAUTHORIZED', 'FORBIDDEN']);

export async function POST(request: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Requisito 2.3.1: esta ruta ES el alta manual, y hasta acá la tenía
  // cualquier tenant logueado — incluido un revisor de Shopify. El gate va
  // ANTES de leer el body: un token que no se puede aceptar tampoco se parsea,
  // ni se prueba contra Shopify, ni se escribe. Ver lib/shopify-manual.server.
  if (!(await puedeEscribirShopifyAMano())) {
    return apiError(SHOPIFY_MANUAL_BLOQUEADO_MESSAGE, 403);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError('JSON inválido', 400);
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(
      parsed.error.errors[0]?.message ?? 'Datos inválidos',
      400,
    );
  }

  const { shopifyStoreUrl, shopifyToken } = parsed.data;

  // Dominio ya vinculado a otro tenant → 409 sin llamar a Shopify. Sólo si el
  // dominio cambia respecto del guardado (D21: los tenants que comparten
  // tienda a propósito pueden volver a cargar el token).
  if (await shopDomainChangeConflicts(shopifyStoreUrl, auth.tenantId)) {
    return apiError(SHOP_DOMAIN_TAKEN_MESSAGE, 409);
  }

  // Verify against Shopify Admin API. La consulta `shop` es la sonda canónica
  // de "¿el token sirve?" — barata y sin efectos de lado.
  //
  // GraphQL, no REST (D27 / requisito 2.2.4 del App Store): desde el 1/4/2025
  // las apps públicas nuevas no pueden tocar el REST Admin API. Se reusa
  // SHOP_INFO_QUERY (lib/shopify-provision), la MISMA query que corre el alta
  // desde el App Store, para no tener dos definiciones del mismo probe.
  let shopName: string | null = null;
  try {
    // Tight timeout: the user is staring at a spinner. If Shopify is slow
    // we'd rather fail fast than hold the wizard hostage.
    const res = await shopifyGraphql<ShopProbeData>(
      shopifyStoreUrl,
      shopifyToken,
      SHOP_INFO_QUERY,
      {},
      { timeoutMs: 8000 },
    );

    // Token inválido/revocado → 401 (a veces 403). Alcances faltantes → HTTP
    // 200 con `errors[].extensions.code = ACCESS_DENIED`: en REST eso era un
    // 403, así que se mapea al mismo mensaje para que el usuario lea lo mismo.
    const authRechazado =
      res.status === 401 ||
      res.status === 403 ||
      res.errors.some((e) => AUTH_ERROR_CODES.has(String(e.extensions?.code ?? '')));

    if (authRechazado) {
      // Las dos razones más comunes de que un token recién generado rebote:
      // (a) el redirect_uri no quedó registrado en la config de la app, y (b)
      // el checkbox "Usar flujo de instalación heredado" sin tildar.
      //
      // 🔴 El mensaje NO linkea /tutorial/shopify-token. Ese tutorial enseña a
      // crearse una app privada y copiar un token, que es justo lo que 2.3.1
      // prohíbe ofrecer, y el error de un 422 es un lugar donde un revisor lo
      // encontraba sin buscarlo. El tutorial sigue existiendo para soporte,
      // pero sólo lo alcanza un admin (app/tutorial/shopify-token/page.tsx).
      return apiError(
        // El conteo se DERIVA de REQUIRED_SCOPES. Escrito a mano decía "10"
        // cuando la app ya pedía nueve, y mandaba al comerciante a buscar un
        // alcance que no existe. Hoy son siete (se podaron
        // read_fulfillments/write_fulfillments, requisito 3.2).
        `Token rechazado por Shopify. Verificá que: (1) los ${REQUIRED_SCOPES.length} alcances estén en el campo "Alcances" del Dev Dashboard, (2) el checkbox "Usar flujo de instalación heredado" esté tildado, y (3) "URLs de redireccionamiento" incluya http://localhost:3456/callback.`,
        422,
      );
    }
    if (res.status !== 200) {
      return apiError(
        `Shopify respondió ${res.status}. Verificá la URL y el token.`,
        422,
      );
    }
    // GraphQL contesta 200 aunque la consulta falle: sin esto un `errors[]`
    // pasaría por OK y se guardaría un token que no sirve.
    if (res.errors.length > 0 || !res.data?.shop) {
      return apiError(
        'Shopify no devolvió los datos de la tienda. Verificá la URL y el token.',
        422,
      );
    }

    shopName = res.data.shop.name ?? null;
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return apiError(
      isTimeout
        ? 'Shopify tardó demasiado en responder. Probá de nuevo.'
        : 'No se pudo conectar a Shopify. Verificá la URL.',
      422,
    );
  }

  // Persist (encrypt token at rest).
  await db.tenant.update({
    where: { id: auth.tenantId },
    data: {
      shopifyStoreUrl,
      shopifyToken: encrypt(shopifyToken),
    },
  });

  return apiSuccess({ ok: true, shopName });
}
