/**
 * Cliente GraphQL mínimo de apps/web para el flujo de la app pública (D27).
 *
 * Sólo lo usan `fetchShopInfo` (alta desde el App Store) y
 * `registerShopifyWebhooks` (post-OAuth): las dos corren únicamente con tokens
 * emitidos por OAuth a la app pública, que desde el 1/4/2025 no puede usar
 * REST. No hay modo ni fallback acá: es GraphQL directo.
 *
 * Sin reintentos: en el callback de OAuth un fallo se responde al comerciante
 * (`shop_info_failed`) y reinstalar es la recuperación natural. Nunca se
 * loguea ni se devuelve el token.
 */

export const SHOPIFY_GRAPHQL_API_VERSION = '2026-07'; // debe coincidir con shopify.app.toml

export interface GraphqlErrorEntry {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: string; [k: string]: unknown };
}

export interface GraphqlResult<T> {
  /** Status HTTP real (200 aunque haya `errors`). 0 si no hubo respuesta. */
  status: number;
  data: T | null;
  errors: GraphqlErrorEntry[];
  /** Cuerpo crudo recortado, sólo para diagnósticos. */
  bodyText: string;
}

export async function shopifyGraphql<T>(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { apiVersion?: string; timeoutMs?: number } = {},
): Promise<GraphqlResult<T>> {
  const apiVersion = opts.apiVersion ?? SHOPIFY_GRAPHQL_API_VERSION;
  const resp = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  const text = await resp.text().catch(() => '');
  let json: { data?: T | null; errors?: GraphqlErrorEntry[] } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    json = {};
  }

  return {
    status: resp.status,
    data: resp.ok ? (json.data ?? null) : null,
    errors: Array.isArray(json.errors) ? json.errors : [],
    bodyText: text.slice(0, 300),
  };
}
