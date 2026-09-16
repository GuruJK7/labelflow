import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import { shopifyGraphql, type GraphqlErrorEntry } from '@/lib/shopify-graphql';

/**
 * POST /api/v1/clean-notes
 * Cleans up error spam from order notes in Shopify.
 * Body: { orderNumbers: ["10900", "10902"] }
 *
 * GRAPHQL, NO REST (2.2.4)
 * ------------------------
 * Antes: `GET orders.json?name=%23N&status=any` + `PUT orders/{id}.json`.
 * Ahora, verificado contra la doc 2026-07 (queries/orders + OrderConnection,
 * mutations/orderUpdate, input-objects/OrderInput):
 *   - búsqueda por número → `orders(query: "name:\"#N\"")`. El término `name`
 *     existe y está documentado (ejemplo de la doc: `name:1001-A`).
 *   - `status=any` de REST → SIN término `status:` en la query. Los valores
 *     válidos de `status:` en GraphQL son `open|closed|cancelled|not_closed`:
 *     no hay `any`, y omitirlo es justamente "sin filtro de estado".
 *   - actualización de la nota → `orderUpdate(input: { id, note })`.
 *
 * El `id` que se usa para actualizar es el GID que devolvió la misma query;
 * no se guarda ni se compara con nada de la base, así que no hace falta
 * extraer el id numérico.
 */

/**
 * Candidatos que se traen por número. REST traía su página default (50) y el
 * código usaba sólo `orders[0]`; acá alcanza con unos pocos para poder
 * quedarse con el que matchea EXACTO y no pagar una página cara por pedido.
 */
const SEARCH_PAGE = 10;

const ORDER_BY_NAME_QUERY = `query LabelFlowCleanNotesOrderByName($query: String!, $first: Int!) {
  orders(first: $first, query: $query) {
    nodes {
      id
      name
      note
    }
  }
}`;

const ORDER_NOTE_UPDATE_MUTATION = `mutation LabelFlowCleanNotesNoteUpdate($input: OrderInput!) {
  orderUpdate(input: $input) {
    order {
      id
      note
    }
    userErrors {
      field
      message
    }
  }
}`;

interface OrdersByNameData {
  orders: { nodes: Array<{ id: string; name: string; note: string | null }> } | null;
}

interface OrderUpdateData {
  orderUpdate: {
    order: { id: string; note: string | null } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  } | null;
}

/**
 * Mismo rol que el `encodeURIComponent` de la versión REST: que un orderNum
 * con espacios, comillas o dos puntos no inyecte términos extra en la query
 * de búsqueda. El valor va entre comillas (sintaxis documentada, p. ej.
 * `metafields.product.material:"gid://..."`) y se escapan `\` y `"`.
 */
function orderNameSearchQuery(orderNum: string): string {
  const escaped = String(orderNum).replace(/[\\"]/g, '\\$&');
  return `name:"#${escaped}"`;
}

/** `null` si la respuesta está sana; si no, el detalle para el `catch`. */
function graphqlFailure<T>(
  res: { status: number; data: T | null; errors: GraphqlErrorEntry[] },
  what: string,
): string | null {
  if (res.status !== 200 || !res.data) {
    return `${what}: status=${res.status} ${JSON.stringify(res.errors ?? []).slice(0, 200)}`;
  }
  // Los errores de GraphQL llegan con HTTP 200 en `errors`: si no se miran,
  // un token sin permisos se ve igual que "el pedido no existe".
  if (res.errors.length > 0) {
    return `${what}: ${res.errors.map((e) => e.message).join(' | ').slice(0, 200)}`;
  }
  return null;
}

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify no configurado', 400);
  }

  const token = await shopifyAccessForTenant(tenant);
  if (!token) return apiError('Token invalid', 500);

  const shop = tenant.shopifyStoreUrl;

  const body = await req.json().catch(() => ({}));
  const orderNumbers: string[] = body.orderNumbers ?? [];

  if (orderNumbers.length === 0) return apiError('No order numbers provided', 400);

  const results: { order: string; status: string }[] = [];

  for (const orderNum of orderNumbers) {
    try {
      // Search for the order by name.
      const searchRes = await shopifyGraphql<OrdersByNameData>(shop, token, ORDER_BY_NAME_QUERY, {
        query: orderNameSearchQuery(orderNum),
        first: SEARCH_PAGE,
      });
      const searchFail = graphqlFailure(searchRes, 'búsqueda');
      if (searchFail) throw new Error(searchFail);

      const nodes = searchRes.data?.orders?.nodes ?? [];
      // La búsqueda por `name` no es exacta (puede traer vecinos). Se prefiere
      // el que coincide letra por letra; si no hay ninguno se cae al primero,
      // que es lo que hacía `searchData.orders?.[0]`.
      const order = nodes.find((n) => n.name === `#${orderNum}`) ?? nodes[0];

      if (!order) {
        results.push({ order: orderNum, status: 'not found' });
        continue;
      }

      const currentNote: string = order.note ?? '';

      // Remove all "LabelFlow ERROR:" lines, keep "LabelFlow-GUIA:" lines
      const cleanedLines = currentNote
        .split('\n')
        .filter((line: string) => !line.includes('LabelFlow ERROR:'))
        .join('\n')
        .trim();

      // Update the order notes. SÓLO `id` y `note`: cualquier otra clave de
      // OrderInput pisaría datos del pedido.
      const updateRes = await shopifyGraphql<OrderUpdateData>(shop, token, ORDER_NOTE_UPDATE_MUTATION, {
        input: { id: order.id, note: cleanedLines },
      });
      const updateFail = graphqlFailure(updateRes, 'orderUpdate');
      if (updateFail) throw new Error(updateFail);

      const userErrors = updateRes.data?.orderUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(
          `orderUpdate: ${userErrors.map((e) => `${(e.field ?? []).join('.')}: ${e.message}`).join(' | ').slice(0, 200)}`,
        );
      }

      results.push({ order: orderNum, status: `cleaned (removed ${currentNote.split('LabelFlow ERROR:').length - 1} errors)` });
    } catch (err) {
      results.push({ order: orderNum, status: `error: ${(err as Error).message}` });
    }
  }

  return apiSuccess({ results });
}
