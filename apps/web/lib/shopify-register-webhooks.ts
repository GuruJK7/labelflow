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
 * IDEMPOTENTE: Shopify devuelve 422 si el (topic, address) ya existe. Eso NO es
 * un error para nosotros — es el estado deseado. Reinstalar no duplica.
 */

const API_VERSION = '2026-07'; // debe coincidir con shopify.app.toml

/** Topics que necesita AutoEnvía. `app/uninstalled` es obligatorio para no seguir cobrando a quien se fue. */
export const WEBHOOK_TOPICS = ['orders/paid', 'app/uninstalled'] as const;

export interface RegisterResult {
  registered: string[];
  /** Ya existían. No es error. */
  alreadyPresent: string[];
  failed: Array<{ topic: string; status: number; body: string }>;
}

export async function registerShopifyWebhooks(
  shop: string,
  accessToken: string,
  appOrigin: string,
  topics: readonly string[] = WEBHOOK_TOPICS,
): Promise<RegisterResult> {
  const out: RegisterResult = { registered: [], alreadyPresent: [], failed: [] };

  for (const topic of topics) {
    const address =
      topic === 'app/uninstalled'
        ? `${appOrigin}/api/shopify/uninstalled`
        : `${appOrigin}/api/webhooks/shopify`;

    try {
      const resp = await fetch(`https://${shop}/admin/api/${API_VERSION}/webhooks.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
        signal: AbortSignal.timeout(15_000),
      });

      if (resp.ok) {
        out.registered.push(topic);
        continue;
      }

      const body = await resp.text().catch(() => '');
      // 422 + "already been taken" = ya estaba. Estado deseado, no falla.
      if (resp.status === 422 && /already been taken|has already/i.test(body)) {
        out.alreadyPresent.push(topic);
        continue;
      }
      out.failed.push({ topic, status: resp.status, body: body.slice(0, 300) });
    } catch (err) {
      out.failed.push({
        topic,
        status: 0,
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}
