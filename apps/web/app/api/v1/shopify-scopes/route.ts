import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import { shopifyGraphql, type GraphqlErrorEntry } from '@/lib/shopify-graphql';
import { REQUIRED_SCOPES } from '@/lib/shopify-oauth';

/**
 * GET /api/v1/shopify-scopes
 * Devuelve los scopes concedidos al token del tenant y cuáles de los
 * críticos faltan. Lo consume el dashboard (`app/(dashboard)/dashboard/
 * page.tsx`) una sola vez al montar: sólo mira `data.missing` para pintar el
 * banner, y si la respuesta no es 2xx no muestra nada.
 *
 * GRAPHQL, NO REST (2.2.4)
 * ------------------------
 * Antes: `GET /admin/api/2024-01/access_scopes.json` → `{ access_scopes:
 * [{ handle, ... }] }`.
 * Ahora, verificado contra la doc 2026-07 (queries/currentAppInstallation):
 *   `query { currentAppInstallation { accessScopes { handle } } }`
 * `AppInstallation.accessScopes` es `[AccessScope!]!` y `AccessScope.handle`
 * es el MISMO string que traía REST (`read_orders`, `write_orders`, …),
 * así que la lista de `required` y la forma de la respuesta no cambian.
 *
 * No hay ids acá: `handle` es un string, no un GID, y no se guarda ni se
 * compara contra nada de la base. Tampoco hay paginación: `accessScopes` es
 * una lista plana, no una connection, así que no existe el `?limit=` que
 * respetar.
 */

const ACCESS_SCOPES_QUERY = `query LabelFlowAccessScopes {
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}`;

interface AccessScopesData {
  currentAppInstallation: {
    accessScopes: Array<{ handle: string }>;
  } | null;
}

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify not configured', 400);
  }

  const token = await shopifyAccessForTenant(tenant);
  if (!token) return apiError('Cannot decrypt token', 500);

  // Check current access scopes
  const res = await shopifyGraphql<AccessScopesData>(
    tenant.shopifyStoreUrl,
    token,
    ACCESS_SCOPES_QUERY,
  );

  // Los errores de GraphQL llegan con HTTP 200 dentro de `errors`: mirar sólo
  // el status dejaría pasar un token sin permisos como "0 scopes", que el
  // dashboard pintaría como "te faltan TODOS los permisos". Cualquier
  // respuesta no sana se trata como el `!res.ok` de la versión REST: 502.
  const installation = res.status === 200 && res.errors.length === 0 ? res.data?.currentAppInstallation : null;

  if (!installation) {
    const detail = res.errors.length > 0
      ? res.errors.map((e: GraphqlErrorEntry) => e.message).join(' | ')
      : res.bodyText;
    console.error(`[shopify-scopes] Shopify API ${res.status}: ${detail.substring(0, 500)}`);
    return apiError('Error consultando scopes de Shopify', 502);
  }

  const scopes = (installation.accessScopes ?? []).map((s: { handle: string }) => s.handle);

  // Qué scopes críticos faltan. 🔴 La lista NO se escribe acá: se importa de
  // `lib/shopify-oauth.ts`, que es lo que la app pide de verdad en el OAuth.
  // Copiada a mano se desincroniza, y el modo de falla es mudo en las dos
  // direcciones: un scope de más y el banner reclama un permiso que la app ya
  // no pide (fue el caso de read_fulfillments/write_fulfillments hasta el
  // 2026-09-16); uno de menos y el banner calla con un permiso que sí falta.
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));

  return apiSuccess({ scopes, missing, total: scopes.length });
}
