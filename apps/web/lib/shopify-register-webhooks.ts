/**
 * Registro de webhooks después de una instalación por OAuth.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * Hoy `orders/paid` no está auto-registrado en ningún lado del código: sólo los
 * de `checkouts/*` (módulo Recover) se registran solos. Sumado a que
 * `SHOPIFY_API_SECRET` no está seteada en producción —y el verificador es
 * fail-closed— el resultado es que hoy NINGÚN webhook de Shopify entra: todas
 * las tiendas despachan por el cron de 15 minutos, nunca al instante.
 *
 * Con OAuth esto se arregla solo: al terminar la instalación tenemos token y
 * secreto, y registramos los topics que importan.
 *
 * GRAPHQL, NO REST (D27)
 * ----------------------
 * La app pública no puede usar REST. Verificado en la doc 2026-07:
 *   - `webhookSubscriptions(first, topics: [WebhookSubscriptionTopic!])` para
 *     saber qué hay (devuelve SÓLO las shop-scoped, no las del TOML).
 *   - `webhookSubscriptionCreate(topic, webhookSubscription: { uri, format })`
 *     (`callbackUrl` está deprecado; `uri` es el vigente).
 *   - topics: `ORDERS_PAID` = orders/paid, `APP_UNINSTALLED` = app/uninstalled.
 *
 * IDEMPOTENTE: antes de crear se consulta; si ya existe (topic + uri) es
 * `alreadyPresent`. No se depende del texto del userError de duplicado
 * (no está documentado). El receptor de webhooks sigue leyendo
 * `X-Shopify-Topic` en formato 'orders/paid': el enum es sólo para hablar
 * con Shopify.
 */

import { shopifyGraphql, SHOPIFY_GRAPHQL_API_VERSION } from '@/lib/shopify-graphql';

const API_VERSION = SHOPIFY_GRAPHQL_API_VERSION; // debe coincidir con shopify.app.toml

/** Topics que necesita AutoEnvía. `app/uninstalled` es obligatorio para no seguir cobrando a quien se fue. */
export const WEBHOOK_TOPICS = ['orders/paid', 'app/uninstalled'] as const;

/** 'orders/paid' → 'ORDERS_PAID' (enum WebhookSubscriptionTopic, verificado). */
export function webhookTopicEnum(topic: string): string {
  return topic.replace(/\//g, '_').toUpperCase();
}

export interface RegisterResult {
  registered: string[];
  /** Ya existían. No es error. */
  alreadyPresent: string[];
  failed: Array<{ topic: string; status: number; body: string }>;
}

export const WEBHOOK_SUBSCRIPTIONS_QUERY = `query LabelFlowWebhookSubscriptions($topics: [WebhookSubscriptionTopic!]!) {
  webhookSubscriptions(first: 50, topics: $topics) {
    nodes {
      id
      topic
      uri
      format
    }
  }
}`;

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `mutation LabelFlowWebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription {
      id
      topic
      uri
      format
    }
    userErrors {
      field
      message
    }
  }
}`;

interface SubscriptionsData {
  webhookSubscriptions: { nodes: Array<{ id: string; topic: string; uri: string; format: string }> };
}

interface CreateData {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string; topic: string; uri: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

function normalizeUri(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase();
}

export function webhookAddressFor(topic: string, appOrigin: string): string {
  return topic === 'app/uninstalled'
    ? `${appOrigin}/api/shopify/uninstalled`
    : `${appOrigin}/api/webhooks/shopify`;
}

export async function registerShopifyWebhooks(
  shop: string,
  accessToken: string,
  appOrigin: string,
  topics: readonly string[] = WEBHOOK_TOPICS,
): Promise<RegisterResult> {
  const out: RegisterResult = { registered: [], alreadyPresent: [], failed: [] };
  const wanted = topics.map((topic) => ({
    topic,
    enumTopic: webhookTopicEnum(topic),
    address: webhookAddressFor(topic, appOrigin),
  }));

  // 1. Qué hay ya (shop-scoped). Si la consulta falla, se sigue intentando
  //    crear: el peor caso es un userError de duplicado que va a `failed`,
  //    nunca una suscripción perdida en silencio.
  let existing: SubscriptionsData['webhookSubscriptions']['nodes'] = [];
  try {
    const res = await shopifyGraphql<SubscriptionsData>(
      shop,
      accessToken,
      WEBHOOK_SUBSCRIPTIONS_QUERY,
      { topics: wanted.map((w) => w.enumTopic) },
      { apiVersion: API_VERSION },
    );
    existing = res.data?.webhookSubscriptions?.nodes ?? [];
  } catch {
    existing = [];
  }

  for (const w of wanted) {
    const present = existing.some(
      (n) => n.topic === w.enumTopic && normalizeUri(n.uri) === normalizeUri(w.address),
    );
    if (present) {
      out.alreadyPresent.push(w.topic);
      continue;
    }

    try {
      const res = await shopifyGraphql<CreateData>(
        shop,
        accessToken,
        WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
        { topic: w.enumTopic, webhookSubscription: { uri: w.address, format: 'JSON' } },
        { apiVersion: API_VERSION },
      );

      if (res.status !== 200 || !res.data) {
        const body = res.errors.length ? JSON.stringify(res.errors) : res.bodyText;
        out.failed.push({ topic: w.topic, status: res.status, body: body.slice(0, 300) });
        continue;
      }

      const payload = res.data.webhookSubscriptionCreate;
      const userErrors = payload?.userErrors ?? [];
      if (userErrors.length > 0 || !payload?.webhookSubscription?.id) {
        // Shopify rechazó con HTTP 200: userErrors es el cuerpo diagnóstico.
        // Un duplicado que la consulta previa no vio (p. ej. carrera con otro
        // callback) también cae acá; el texto exacto no está documentado.
        if (userErrors.some((e) => /already|taken|exists/i.test(e.message))) {
          out.alreadyPresent.push(w.topic);
          continue;
        }
        out.failed.push({
          topic: w.topic,
          status: 200,
          body: JSON.stringify(userErrors.length ? userErrors : res.errors).slice(0, 300),
        });
        continue;
      }

      out.registered.push(w.topic);
    } catch (err) {
      out.failed.push({
        topic: w.topic,
        status: 0,
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}
