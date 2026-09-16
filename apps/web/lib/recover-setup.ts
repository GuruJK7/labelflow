/**
 * Recover module setup utilities.
 * Handles Shopify webhook registration when a tenant activates the Recover module.
 *
 * GRAPHQL, NO REST (requisito 2.2.4 del App Store)
 * ------------------------------------------------
 * Desde el 1/4/2025 una app pública nueva no puede usar la Admin REST API.
 * Estas dos funciones hablaban REST contra `webhooks.json`; ahora van por
 * `shopifyGraphql`. Equivalencias verificadas contra el schema 2026-07
 * (validador oficial, no de memoria):
 *   - GET  webhooks.json            → `webhookSubscriptions(first: 50, topics:)`
 *   - POST webhooks.json            → `webhookSubscriptionCreate(topic, webhookSubscription: { uri, format })`
 *   - DELETE webhooks/{id}.json     → `webhookSubscriptionDelete(id)`
 *   - topics: `CHECKOUTS_CREATE` = checkouts/create, `CHECKOUTS_UPDATE` = checkouts/update.
 *
 * IDEMPOTENCIA: REST la daba gratis (422 "address has already been taken" que
 * el código viejo tragaba). GraphQL responde HTTP 200 con `userErrors`, así que
 * se consulta ANTES de crear —mismo patrón que `shopify-register-webhooks.ts`—
 * y el userError de duplicado queda como red de seguridad para la carrera.
 *
 * El receptor (`/api/webhooks/shopify/checkouts`) no cambia: sigue leyendo
 * `X-Shopify-Topic` en formato 'checkouts/create'. El enum es sólo para hablar
 * con Shopify.
 */

import { db } from '@/lib/db';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import { shopifyGraphql, SHOPIFY_GRAPHQL_API_VERSION } from '@/lib/shopify-graphql';

const API_VERSION = SHOPIFY_GRAPHQL_API_VERSION;

/** Topic REST → enum `WebhookSubscriptionTopic`. Los dos del módulo Recover. */
const CHECKOUT_TOPICS = [
  { topic: 'checkouts/create', enumTopic: 'CHECKOUTS_CREATE' },
  { topic: 'checkouts/update', enumTopic: 'CHECKOUTS_UPDATE' },
] as const;

/**
 * `$topics` va nullable a propósito: con la lista filtra (alta) y con `null`
 * devuelve todas, que es lo que hacía el GET de REST en la baja.
 * `first: 50` = el límite por defecto que tenía `webhooks.json`.
 */
const WEBHOOK_SUBSCRIPTIONS_QUERY = `query LabelFlowRecoverWebhookSubscriptions($topics: [WebhookSubscriptionTopic!]) {
  webhookSubscriptions(first: 50, topics: $topics) {
    nodes {
      id
      topic
      uri
    }
  }
}`;

const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `mutation LabelFlowRecoverWebhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription {
      id
      topic
      uri
    }
    userErrors {
      field
      message
    }
  }
}`;

const WEBHOOK_SUBSCRIPTION_DELETE_MUTATION = `mutation LabelFlowRecoverWebhookDelete($id: ID!) {
  webhookSubscriptionDelete(id: $id) {
    deletedWebhookSubscriptionId
    userErrors {
      field
      message
    }
  }
}`;

interface WebhookNode {
  id: string;
  topic: string;
  uri: string;
}

interface SubscriptionsData {
  webhookSubscriptions: { nodes: WebhookNode[] };
}

interface CreateData {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string; topic: string; uri: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

interface DeleteData {
  webhookSubscriptionDelete: {
    deletedWebhookSubscriptionId: string | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

function normalizeUri(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Lista las suscripciones shop-scoped de la app. `topics: null` = todas.
 * Devuelve `null` si la consulta no se pudo completar, para que cada llamador
 * decida (la alta sigue igual; la baja corta, como hacía el `!listRes.ok`).
 */
async function listWebhookSubscriptions(
  shop: string,
  accessToken: string,
  topics: string[] | null,
): Promise<WebhookNode[] | null> {
  const res = await shopifyGraphql<SubscriptionsData>(
    shop,
    accessToken,
    WEBHOOK_SUBSCRIPTIONS_QUERY,
    { topics },
    { apiVersion: API_VERSION },
  );

  // Los errores de GraphQL llegan con HTTP 200: `data` null + `errors` cargado.
  if (res.status !== 200 || !res.data) return null;
  return res.data.webhookSubscriptions?.nodes ?? [];
}

/**
 * Registers Shopify checkout webhooks for a tenant.
 * Call this when a tenant activates the Recover module.
 * Idempotente — si el webhook ya existe se cuenta como éxito.
 *
 * @returns true if all webhooks were registered successfully (or already existed)
 */
export async function registerShopifyRecoverWebhooks(tenantId: string): Promise<boolean> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant.shopifyToken) {
    console.warn(`[Recover Setup] Tenant ${tenantId} missing Shopify credentials`);
    return false;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    console.warn('[Recover Setup] NEXT_PUBLIC_APP_URL not set');
    return false;
  }

  const accessToken = await shopifyAccessForTenant(tenant);
  if (!accessToken) {
    console.warn(`[Recover Setup] Failed to decrypt Shopify token for tenant ${tenantId}`);
    return false;
  }

  const webhookUrl = `${appUrl}/api/webhooks/shopify/checkouts`;
  let allSucceeded = true;

  // Qué hay ya. Si la consulta falla se sigue intentando crear: el peor caso
  // es un userError de duplicado (que abajo se trata como éxito, igual que el
  // 422 de REST), nunca una suscripción perdida en silencio.
  let existing: WebhookNode[] = [];
  try {
    existing = (await listWebhookSubscriptions(
      tenant.shopifyStoreUrl,
      accessToken,
      CHECKOUT_TOPICS.map((t) => t.enumTopic),
    )) ?? [];
  } catch {
    existing = [];
  }

  for (const { topic, enumTopic } of CHECKOUT_TOPICS) {
    const present = existing.some(
      (n) => n.topic === enumTopic && normalizeUri(n.uri) === normalizeUri(webhookUrl),
    );
    if (present) {
      console.warn(`[Recover Setup] Webhook ${topic} registered for tenant ${tenantId}`);
      continue;
    }

    try {
      const res = await shopifyGraphql<CreateData>(
        tenant.shopifyStoreUrl,
        accessToken,
        WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
        { topic: enumTopic, webhookSubscription: { uri: webhookUrl, format: 'JSON' } },
        { apiVersion: API_VERSION },
      );

      if (res.status !== 200 || !res.data) {
        console.warn(
          `[Recover Setup] Failed to register webhook ${topic} for tenant ${tenantId}:`,
          res.errors.length ? res.errors : res.bodyText,
        );
        allSucceeded = false;
        continue;
      }

      const payload = res.data.webhookSubscriptionCreate;
      const userErrors = payload?.userErrors ?? [];

      if (userErrors.length > 0 || !payload?.webhookSubscription?.id) {
        // Shopify rechazó con HTTP 200. El duplicado que la consulta previa no
        // vio (carrera con otra activación) es el viejo 422: no es error.
        if (userErrors.some((e) => /already|taken|exists/i.test(e.message))) {
          console.warn(`[Recover Setup] Webhook ${topic} registered for tenant ${tenantId}`);
          continue;
        }
        console.warn(
          `[Recover Setup] Failed to register webhook ${topic} for tenant ${tenantId}:`,
          userErrors.length ? userErrors : res.errors,
        );
        allSucceeded = false;
        continue;
      }

      console.warn(`[Recover Setup] Webhook ${topic} registered for tenant ${tenantId}`);
    } catch (err) {
      console.warn(
        `[Recover Setup] Network error registering webhook ${topic}:`,
        (err as Error).message
      );
      allSucceeded = false;
    }
  }

  return allSucceeded;
}

/**
 * Deregisters Shopify checkout webhooks for a tenant.
 * Call this when a tenant cancels the Recover subscription.
 */
export async function unregisterShopifyRecoverWebhooks(tenantId: string): Promise<void> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant.shopifyToken) return;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return;

  const accessToken = await shopifyAccessForTenant(tenant);
  if (!accessToken) return;

  const webhookUrl = `${appUrl}/api/webhooks/shopify/checkouts`;

  try {
    // List current webhooks. Sin filtro de topic: REST listaba todas y filtraba
    // por `address`, y borrar por URI tiene que seguir alcanzando a cualquier
    // suscripción vieja apuntada a este receptor.
    const nodes = await listWebhookSubscriptions(tenant.shopifyStoreUrl, accessToken, null);
    if (nodes === null) return;

    const toDelete = nodes.filter((wh) => normalizeUri(wh.uri) === normalizeUri(webhookUrl));

    for (const wh of toDelete) {
      // `wh.id` ya es el GID que espera la mutación; nada de esto toca la base.
      await shopifyGraphql<DeleteData>(
        tenant.shopifyStoreUrl,
        accessToken,
        WEBHOOK_SUBSCRIPTION_DELETE_MUTATION,
        { id: wh.id },
        { apiVersion: API_VERSION },
      ).catch(() => undefined);
    }
  } catch {
    // Non-fatal
  }
}
