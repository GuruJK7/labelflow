import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import { shopifyGraphql, type GraphqlErrorEntry, type GraphqlResult } from '@/lib/shopify-graphql';

import { rastreoDeLabel } from '@/lib/transportista';

/**
 * POST /api/v1/fulfill-retry
 * Retroactively fulfills orders in Shopify that have a DAC guia but were never fulfilled.
 * Body: { labelIds?: string[] }  — if empty, auto-detects all CREATED/COMPLETED labels missing fulfillment.
 *
 * GRAPHQL, NO REST (requisito 2.2.4 del App Store)
 * ------------------------------------------------
 * Las tres llamadas REST que tenía esta ruta pasaron a GraphQL 2026-07 vía
 * `shopifyGraphql`. Es el mismo mapeo que ya usa el worker en
 * `apps/worker/src/shopify/fulfillment-graphql.ts` (verificado contra la doc
 * 2026-07 antes de escribirlo):
 *
 *   GET  /orders/{id}/fulfillment_orders.json
 *        → `order(id) { fulfillmentOrders(first: 50) { nodes { id status } } }`
 *          El `first: 50` es el mismo tope que traía REST por defecto.
 *          `FulfillmentOrderStatus` es MAYÚSCULAS: el `status === 'open'` de
 *          antes es `'OPEN'` acá.
 *   POST /fulfillments.json
 *        → `fulfillmentCreate(fulfillment: FulfillmentInput!)` con
 *          `lineItemsByFulfillmentOrder` (GIDs de fulfillment order, no ids
 *          numéricos), `trackingInfo { number url company }` y
 *          `notifyCustomer: true`. Sin `fulfillmentOrderLineItems`: si no se
 *          especifican líneas, la mutación fulfillea todo lo que queda del
 *          fulfillment order — igual que el POST REST de antes.
 *   PUT  /orders/{id}.json { tags }
 *        → `tagsAdd(id, tags)`.
 *
 * DOS DIFERENCIAS DE FORMA QUE MUERDEN:
 *   1. GraphQL contesta HTTP 200 aunque falle: se mira SIEMPRE `errors[]` y
 *      los `userErrors` de la mutación, nunca sólo el status. Por eso los
 *      mensajes de `results[].error` pueden traer "(200)" en el paréntesis del
 *      status: el formato del string se mantiene igual que en REST, y el
 *      detalle que sigue son los mensajes de GraphQL.
 *   2. Falta de permisos: REST daba 403 + "required permission"; GraphQL da
 *      200 + `errors[].extensions.code = ACCESS_DENIED`, o el pedido con
 *      `fulfillmentOrders: null`. Los dos casos se traducen al MISMO mensaje
 *      accionable de scopes que veía el operador antes.
 *
 * El contrato de salida no cambia: `{ data: { fulfilled, total, results[] },
 * meta }`, con `results[] = { orderName, guia, success, error? }`.
 */

const FULFILLMENT_ORDERS_QUERY = `query LabelFlowRetryFulfillmentOrders($id: ID!) {
  order(id: $id) {
    id
    fulfillmentOrders(first: 50) {
      nodes {
        id
        status
      }
    }
  }
}`;

const FULFILLMENT_CREATE_MUTATION = `mutation LabelFlowRetryFulfillmentCreate($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment {
      id
      legacyResourceId
    }
    userErrors {
      field
      message
    }
  }
}`;

const TAGS_ADD_MUTATION = `mutation LabelFlowRetryTagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node {
      id
    }
    userErrors {
      field
      message
    }
  }
}`;

/** El mensaje accionable de scopes que ya veía el operador con REST. No cambiar el texto. */
const MISSING_SCOPES_ERROR =
  'Missing scopes on Shopify Custom App. Required: read/write_assigned_fulfillment_orders + read/write_merchant_managed_fulfillment_orders. Fix: Shopify Partners → app config → API access scopes → tick all four → save → reinstall app.';

interface FulfillmentOrderNode {
  id: string;
  status: string;
}

interface FulfillmentOrdersData {
  order: {
    id: string;
    fulfillmentOrders: { nodes: FulfillmentOrderNode[] } | null;
  } | null;
}

interface UserErrorEntry {
  field?: string[] | null;
  message: string;
}

interface FulfillmentCreateData {
  fulfillmentCreate: {
    fulfillment: { id: string; legacyResourceId?: string | null } | null;
    userErrors: UserErrorEntry[];
  } | null;
}

/**
 * GID de pedido a partir de lo que guarda `Label.shopifyOrderId` (el id
 * numérico de REST). El `split('/')` es defensa barata por si alguna fila
 * llegara a tener ya un GID guardado: sin él quedaría un GID anidado.
 */
function orderGid(shopifyOrderId: string): string {
  const numeric = String(shopifyOrderId).trim().split('/').pop() ?? '';
  return `gid://shopify/Order/${numeric}`;
}

/** ¿Shopify rechazó por permisos? Cubre el code de GraphQL y el texto de REST. */
function isAccessDenied(errors: GraphqlErrorEntry[], bodyText: string): boolean {
  if (errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) return true;
  if (errors.some((e) => /required permission|access denied/i.test(e.message ?? ''))) return true;
  return /required permission/i.test(bodyText);
}

/** Detalle recortado para `results[].error`, con el mismo tope de 200 que tenía REST. */
function detailOf(res: GraphqlResult<unknown>): string {
  const msgs = res.errors
    .map((e) => e.message)
    .filter(Boolean)
    .join('; ');
  return (msgs || res.bodyText || `HTTP ${res.status}`).substring(0, 200);
}

/** `userErrors` de una mutación, con el mismo formato "campo: mensaje" del worker. */
function formatUserErrors(userErrors: UserErrorEntry[]): string {
  return userErrors
    .map((e) => `${(e.field ?? []).join('.') || '-'}: ${e.message}`)
    .join('; ')
    .substring(0, 200);
}

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenantId = auth.tenantId;

  let labelIds: string[] = [];
  try {
    const body = await req.json();
    labelIds = body?.labelIds ?? [];
  } catch {
    // no body
  }

  // Load tenant credentials
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify credentials not configured', 400);
  }

  const shopifyToken = await shopifyAccessForTenant(tenant);
  if (!shopifyToken) {
    return apiError('Cannot decrypt Shopify token', 500);
  }

  const shop = tenant.shopifyStoreUrl;

  // Find labels to fulfill
  const where: Record<string, unknown> = {
    tenantId,
    status: { in: ['CREATED', 'COMPLETED'] },
    dacGuia: { not: null },
  };
  if (labelIds.length > 0) {
    where.id = { in: labelIds };
  }

  const labels = await db.label.findMany({
    where,
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      dacGuia: true,
      carrier: true,
    },
  });

  if (labels.length === 0) {
    return apiSuccess({ fulfilled: 0, results: [] }, { message: 'No labels found to fulfill' });
  }

  const results: { orderName: string; guia: string; success: boolean; error?: string }[] = [];

  for (const label of labels) {
    const guia = label.dacGuia!;
    if (guia.startsWith('PENDING-')) {
      results.push({ orderName: label.shopifyOrderName, guia, success: false, error: 'Guia is pending' });
      continue;
    }

    const gid = orderGid(label.shopifyOrderId);

    try {
      // Step 1: Get open fulfillment orders
      const foRes = await shopifyGraphql<FulfillmentOrdersData>(shop, shopifyToken, FULFILLMENT_ORDERS_QUERY, {
        id: gid,
      });

      // Sin `data` no hay nada que mirar: o el transporte falló (4xx/5xx) o
      // GraphQL abortó la query entera. Los permisos faltantes se separan acá
      // para que el operador siga viendo el mensaje accionable, igual que con
      // el 403 + "required permission" de REST.
      if (!foRes.data) {
        if (isAccessDenied(foRes.errors, foRes.bodyText)) {
          results.push({
            orderName: label.shopifyOrderName,
            guia,
            success: false,
            error: MISSING_SCOPES_ERROR,
          });
          continue;
        }
        results.push({
          orderName: label.shopifyOrderName,
          guia,
          success: false,
          error: `Fulfillment orders fetch failed (${foRes.status}): ${detailOf(foRes)}`,
        });
        continue;
      }

      const order = foRes.data.order;
      if (!order) {
        results.push({
          orderName: label.shopifyOrderName,
          guia,
          success: false,
          error: `Fulfillment orders fetch failed (${foRes.status}): order ${label.shopifyOrderId} not found in Shopify`,
        });
        continue;
      }

      // Permiso faltante SÓLO en el campo: Shopify manda el pedido con
      // `fulfillmentOrders: null` y el motivo en `errors[]` por path.
      if (!order.fulfillmentOrders) {
        results.push({
          orderName: label.shopifyOrderName,
          guia,
          success: false,
          error: isAccessDenied(foRes.errors, foRes.bodyText)
            ? MISSING_SCOPES_ERROR
            : `Fulfillment orders fetch failed (${foRes.status}): ${detailOf(foRes)}`,
        });
        continue;
      }

      // `FulfillmentOrderStatus` es un enum en MAYÚSCULAS (OPEN, IN_PROGRESS,
      // CLOSED, CANCELLED, INCOMPLETE, ON_HOLD, SCHEDULED). 'OPEN' es el
      // mismo subconjunto que filtraba el `status === 'open'` de REST.
      const openOrders = order.fulfillmentOrders.nodes.filter((fo) => fo.status === 'OPEN');

      if (openOrders.length === 0) {
        // Might already be fulfilled
        results.push({ orderName: label.shopifyOrderName, guia, success: true, error: 'Already fulfilled (no open fulfillment orders)' });
        continue;
      }

      // Step 2: Create fulfillment with tracking
      // [03-sep-2026] Antes esto era siempre el rastreador de DAC. Con
      // notify_customer:true, un envío de reparto propio o de Correo le mandaba
      // al comprador un link a un sitio que no conoce su código. Cuando el
      // transportista no tiene rastreo público se manda el fulfillment SIN url,
      // que es lo que Shopify espera para ese caso.
      const rastreo = rastreoDeLabel(label.carrier, guia);
      const trackingUrl = rastreo.url;
      const fulfillRes = await shopifyGraphql<FulfillmentCreateData>(
        shop,
        shopifyToken,
        FULFILLMENT_CREATE_MUTATION,
        {
          fulfillment: {
            lineItemsByFulfillmentOrder: openOrders.map((fo) => ({ fulfillmentOrderId: fo.id })),
            trackingInfo: {
              number: guia,
              ...(trackingUrl ? { url: trackingUrl } : {}),
              company: rastreo.nombre,
            },
            notifyCustomer: true,
          },
        },
      );

      if (!fulfillRes.data) {
        results.push({
          orderName: label.shopifyOrderName,
          guia,
          success: false,
          error: `Fulfillment failed (${fulfillRes.status}): ${detailOf(fulfillRes)}`,
        });
        continue;
      }

      const payload = fulfillRes.data.fulfillmentCreate;
      const userErrors = payload?.userErrors ?? [];
      if (userErrors.length > 0) {
        results.push({
          orderName: label.shopifyOrderName,
          guia,
          success: false,
          error: `Fulfillment failed (${fulfillRes.status}): ${formatUserErrors(userErrors)}`,
        });
        continue;
      }

      if (!payload?.fulfillment?.id) {
        results.push({ orderName: label.shopifyOrderName, guia, success: false, error: 'No fulfillment ID returned' });
        continue;
      }

      // Step 3: Also tag the order as "RASTREO ENVIADO"
      // Best-effort, igual que antes: el resultado no se mira y un fallo acá
      // nunca invalida el fulfillment que ya se creó.
      await shopifyGraphql(shop, shopifyToken, TAGS_ADD_MUTATION, {
        id: gid,
        tags: ['RASTREO ENVIADO'],
      }).catch(() => {});

      results.push({ orderName: label.shopifyOrderName, guia, success: true });
    } catch (err) {
      results.push({ orderName: label.shopifyOrderName, guia, success: false, error: (err as Error).message });
    }
  }

  const fulfilled = results.filter(r => r.success && !r.error?.includes('Already')).length;
  return apiSuccess({ fulfilled, total: labels.length, results });
}
