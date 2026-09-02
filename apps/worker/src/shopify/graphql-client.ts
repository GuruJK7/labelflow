import logger from '../logger';

/**
 * Cliente mínimo de la Admin API GraphQL de Shopify (D27).
 *
 * POR QUÉ EXISTE
 * --------------
 * Las apps públicas creadas desde el 1/4/2025 sólo pueden usar GraphQL
 * (shopify.dev/docs/api/admin-rest). El primer install real de AutoEnvía en
 * autoenvia-qa pasó OAuth y murió en `shop.json` (REST). Este cliente es la
 * única puerta de salida a GraphQL del worker: los adaptadores
 * (`orders-graphql.ts`, `fulfillment-graphql.ts`) construyen sobre él la MISMA
 * forma REST que hoy consumen los jobs y `dac/shipment.ts`.
 *
 * QUÉ HACE
 * --------
 *   - POST https://<shop>/admin/api/2026-07/graphql.json con
 *     `X-Shopify-Access-Token`, timeout 20 s.
 *   - Shopify responde HTTP 200 aun con errores: se lee SIEMPRE `errors[]`
 *     (`extensions.code`: THROTTLED, MAX_COST_EXCEEDED, ACCESS_DENIED,
 *     SHOP_INACTIVE, INTERNAL_SERVER_ERROR — verificados en
 *     shopify.dev/docs/api/admin-graphql) y `extensions.cost`.
 *   - THROTTLED → espera lo que indique `throttleStatus` y reintenta (máx 3).
 *   - Red / 5xx / 429 → reintento exponencial corto (500 ms, 1 s, 2 s).
 *   - Errores parciales por `path` con `data` presente (típico: datos
 *     protegidos de cliente que la app todavía no tiene aprobados) NO abortan:
 *     se loguean una vez por tienda y se sigue con los campos en null.
 *   - Nunca loguea ni incluye el token en ningún mensaje de error.
 *
 * Lo que NO hace: mapear a REST (eso es de los adaptadores) ni elegir modo
 * (eso es de `mode.ts`).
 */

export const SHOPIFY_GRAPHQL_API_VERSION = '2026-07';

export type ShopifyGraphqlErrorCode =
  | 'THROTTLED'
  | 'MAX_COST_EXCEEDED'
  | 'ACCESS_DENIED'
  | 'SHOP_INACTIVE'
  | 'INTERNAL_SERVER_ERROR'
  | string;

export interface GraphqlErrorEntry {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: ShopifyGraphqlErrorCode; [k: string]: unknown };
}

export interface GraphqlCost {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: {
    maximumAvailable?: number;
    currentlyAvailable?: number;
    restoreRate?: number;
  };
}

export interface GraphqlResponse<T> {
  data?: T | null;
  errors?: GraphqlErrorEntry[];
  extensions?: { cost?: GraphqlCost; [k: string]: unknown };
}

export interface UserError {
  field?: string[] | null;
  message: string;
}

/**
 * Error tipado de GraphQL. `code` es el primer `extensions.code` que vino en
 * `errors[]` (o `HTTP_<status>` para fallos de transporte), así los
 * adaptadores pueden distinguir "sin permisos" de "costo excedido" sin
 * parsear texto.
 */
export class ShopifyGraphqlError extends Error {
  readonly isShopifyGraphqlError = true as const;
  constructor(
    message: string,
    readonly code: ShopifyGraphqlErrorCode | null,
    readonly errors: GraphqlErrorEntry[] = [],
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'ShopifyGraphqlError';
  }
}

export function isGraphqlAccessDenied(err: unknown): err is ShopifyGraphqlError {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as ShopifyGraphqlError).isShopifyGraphqlError === true &&
    (err as ShopifyGraphqlError).code === 'ACCESS_DENIED'
  );
}

export function isGraphqlMaxCostExceeded(err: unknown): err is ShopifyGraphqlError {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as ShopifyGraphqlError).isShopifyGraphqlError === true &&
    (err as ShopifyGraphqlError).code === 'MAX_COST_EXCEEDED'
  );
}

/**
 * Lanza si una mutación devolvió `userErrors`. El mensaje lleva la operación
 * y los errores serializados (campo + mensaje), que es lo que el runlog del
 * dashboard necesita para que el operador entienda qué rechazó Shopify.
 */
export function assertNoUserErrors(operation: string, userErrors: UserError[] | null | undefined): void {
  if (!userErrors || userErrors.length === 0) return;
  const detail = userErrors
    .map((e) => `${(e.field ?? []).join('.') || '-'}: ${e.message}`)
    .join('; ');
  throw new ShopifyGraphqlError(`Shopify ${operation} failed: ${detail}`, 'USER_ERRORS');
}

export interface ShopifyGraphqlClient {
  readonly storeUrl: string;
  readonly apiVersion: string;
  /**
   * Ejecuta una query/mutación. Devuelve `data` ya desenvuelto; el último
   * `extensions.cost` queda disponible en `lastCost` para calibrar páginas.
   */
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  lastCost: GraphqlCost | null;
}

export interface GraphqlClientOptions {
  apiVersion?: string;
  timeoutMs?: number;
  /** Inyectable para tests. Default: `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Inyectable para tests: reemplaza `setTimeout` en las esperas. */
  sleep?: (ms: number) => Promise<void>;
  maxThrottleRetries?: number;
  maxTransportRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const TRANSPORT_BACKOFF_MS = [500, 1_000, 2_000];

/** Un aviso por tienda+código para no llenar el log en cada página. */
const partialErrorsWarned = new Set<string>();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeErrors(errors: GraphqlErrorEntry[]): string {
  return JSON.stringify(
    errors.map((e) => ({ message: e.message, code: e.extensions?.code, path: e.path })),
  ).slice(0, 400);
}

/** Segundos a esperar para que el bucket recupere lo que pide la query (mín. 1). */
export function throttleWaitSeconds(cost: GraphqlCost | undefined): number {
  const requested = cost?.requestedQueryCost ?? 0;
  const available = cost?.throttleStatus?.currentlyAvailable ?? 0;
  const restore = cost?.throttleStatus?.restoreRate ?? 50;
  if (restore <= 0) return 1;
  const secs = Math.ceil((requested - available) / restore);
  return Math.max(1, Number.isFinite(secs) ? secs : 1);
}

export function createShopifyGraphqlClient(
  storeUrl: string,
  token: string,
  opts: GraphqlClientOptions = {},
): ShopifyGraphqlClient {
  const apiVersion = opts.apiVersion ?? SHOPIFY_GRAPHQL_API_VERSION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxThrottleRetries = opts.maxThrottleRetries ?? 3;
  const maxTransportRetries = opts.maxTransportRetries ?? TRANSPORT_BACKOFF_MS.length;
  const endpoint = `https://${storeUrl}/admin/api/${apiVersion}/graphql.json`;

  const client: ShopifyGraphqlClient = {
    storeUrl,
    apiVersion,
    lastCost: null,
    async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      let throttleRetries = 0;
      let transportRetries = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        let resp: Response;
        try {
          resp = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          // Red / timeout: reintento corto. El token no viaja en el mensaje.
          if (transportRetries < maxTransportRetries) {
            const wait = TRANSPORT_BACKOFF_MS[Math.min(transportRetries, TRANSPORT_BACKOFF_MS.length - 1)];
            transportRetries++;
            logger.warn({ storeUrl, attempt: transportRetries, wait }, 'Shopify GraphQL network error, retrying');
            await sleep(wait);
            continue;
          }
          throw new ShopifyGraphqlError(
            `Shopify GraphQL network error for ${storeUrl}: ${err instanceof Error ? err.message : String(err)}`,
            'NETWORK',
          );
        }

        if (resp.status >= 500 || resp.status === 429) {
          if (transportRetries < maxTransportRetries) {
            const wait = TRANSPORT_BACKOFF_MS[Math.min(transportRetries, TRANSPORT_BACKOFF_MS.length - 1)];
            transportRetries++;
            logger.warn({ storeUrl, status: resp.status, attempt: transportRetries, wait }, 'Shopify GraphQL transport error, retrying');
            await sleep(wait);
            continue;
          }
          throw new ShopifyGraphqlError(
            `Shopify GraphQL HTTP ${resp.status} for ${storeUrl}`,
            `HTTP_${resp.status}`,
            [],
            resp.status,
          );
        }

        if (!resp.ok) {
          // 401 token inválido · 402 tienda congelada · 403 tienda marcada como
          // fraudulenta (NO es "sin scopes") · 404 · 423 bloqueada. Ninguno se
          // reintenta en el mismo ciclo; el mensaje no lleva el token.
          const body = await resp.text().catch(() => '');
          throw new ShopifyGraphqlError(
            `Shopify GraphQL HTTP ${resp.status} for ${storeUrl}: ${body.slice(0, 200)}`,
            `HTTP_${resp.status}`,
            [],
            resp.status,
          );
        }

        const json = (await resp.json()) as GraphqlResponse<T>;
        const cost = json.extensions?.cost;
        if (cost) {
          client.lastCost = cost;
          const max = cost.throttleStatus?.maximumAvailable;
          const cur = cost.throttleStatus?.currentlyAvailable;
          if (typeof max === 'number' && typeof cur === 'number' && cur < max * 0.2) {
            logger.warn({ storeUrl, currentlyAvailable: cur, maximumAvailable: max }, 'Shopify GraphQL rate limit high');
          }
        }

        const errors = json.errors ?? [];
        if (errors.length === 0) {
          if (json.data == null) {
            throw new ShopifyGraphqlError(`Shopify GraphQL returned no data for ${storeUrl}`, 'NO_DATA');
          }
          return json.data;
        }

        const codes = errors.map((e) => e.extensions?.code).filter(Boolean) as string[];

        if (codes.includes('THROTTLED')) {
          if (throttleRetries < maxThrottleRetries) {
            throttleRetries++;
            const waitS = throttleWaitSeconds(cost);
            logger.warn({ storeUrl, waitS, attempt: throttleRetries }, 'Shopify GraphQL throttled, waiting');
            await sleep(waitS * 1000);
            continue;
          }
          throw new ShopifyGraphqlError(
            `Shopify GraphQL throttled for ${storeUrl} after ${maxThrottleRetries} retries`,
            'THROTTLED',
            errors,
          );
        }

        // Errores parciales: `data` vino y todos los errores apuntan a un
        // `path` (campo en null por permisos de datos protegidos, etc.). No se
        // aborta el ciclo: el adaptador rellena con null/'' y el pedido sigue.
        const allByPath = errors.every((e) => Array.isArray(e.path) && e.path.length > 0);
        if (json.data != null && allByPath && !codes.includes('ACCESS_DENIED')) {
          const key = `${storeUrl}|${codes.join(',')}|${errors[0]?.path?.join('.')}`;
          if (!partialErrorsWarned.has(key)) {
            partialErrorsWarned.add(key);
            logger.warn({ storeUrl, errors: summarizeErrors(errors) }, 'Shopify GraphQL partial errors (continuing with null fields)');
          }
          return json.data;
        }

        const code = codes[0] ?? null;
        const label = code === 'ACCESS_DENIED'
          ? 'access denied (missing scope or protected data approval)'
          : code === 'MAX_COST_EXCEEDED'
            ? 'query cost exceeded'
            : 'error';
        throw new ShopifyGraphqlError(
          `Shopify GraphQL ${label} for ${storeUrl}: ${summarizeErrors(errors)}`,
          code,
          errors,
          200,
        );
      }
    },
  };

  return client;
}

/** Sólo para tests: vuelve a avisar errores parciales. */
export function _resetGraphqlPartialWarnings(): void {
  partialErrorsWarned.clear();
}
