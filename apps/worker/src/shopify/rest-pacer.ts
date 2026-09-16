/**
 * Ritmo para el cliente REST de Shopify: respeta el leaky bucket y reintenta
 * los 429 esperando lo que diga `Retry-After`.
 *
 * POR QUÉ EXISTE. `client.ts` lee el bucket (`X-Shopify-Shop-Api-Call-Limit`)
 * en cada respuesta pero sólo lo LOGUEA ("Shopify rate limit high"): no espera
 * ni reintenta. Al camino principal nunca le hizo falta porque entre request y
 * request hay minutos de Playwright. Al job SIN ETIQUETA sí: en el boot barre
 * hasta 40 rotas + 80 recuperadas por tienda, 1–2 requests cada una y sin
 * pausa, así que vacía el bucket (40, drena 2/s) en 20 requests y come 429 en
 * el resto. Visto el 16-09-2026 en dos arranques seguidos del worker, tres
 * tenants, decenas de pedidos con `No pude sacar el tag`. GraphQL ya se cuida
 * solo (`graphql-client.ts` espera `throttleStatus`); esto es el equivalente
 * para REST.
 *
 * QUÉ HACE. Es opt-in: se instala sobre el AxiosInstance del cliente que lo
 * pida (`client.rest`), y sólo ese cliente cambia de comportamiento.
 *   - Lee `X-Shopify-Shop-Api-Call-Limit` de CADA respuesta (2xx y 429) y
 *     guarda `used/max` con la hora en que se leyó.
 *   - Antes de cada request estima cuánto drenó desde esa lectura y, si el
 *     bucket proyectado supera `max × (1 − reserva)`, duerme lo justo para que
 *     la request entre. La reserva (25 %) le deja lugar al resto del proceso,
 *     que comparte el bucket de la tienda (el despacho, el fulfillment).
 *   - Ante 429 duerme `Retry-After` (segundos; es lo que manda la doc) o un
 *     backoff exponencial si no viene, y re-emite la MISMA request hasta
 *     `maxRetries` veces. Recién ahí el error sube al que llamó.
 *   - La admisión es secuencial: N requests concurrentes entran de a una y
 *     cada una cuenta a las que ya salieron y todavía no volvieron.
 *
 * NÚMEROS (shopify.dev/docs/api/admin-rest/usage/rate-limits, leído el
 * 16-09-2026): standard 40 req / drena 2 por s · Advanced 40 / 4 · Plus 400 /
 * 20. La tasa NO se deduce del tamaño (Advanced comparte el 40 con standard),
 * así que se asume la MÁS LENTA que existe para cada tamaño: `max(2, max/20)`.
 * En el peor caso esperamos de más; nunca de menos.
 */
import type { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import logger from '../logger';

export interface RestPacerOptions {
  /** Fracción del bucket que se deja libre para el resto del proceso. Default 0.25. */
  reserva?: number;
  /** Reintentos ante 429 antes de dejar subir el error. Default 4. */
  maxRetries?: number;
  /** Tope de cualquier espera individual. Default 30 s. */
  maxWaitMs?: number;
  /** Inyectable para tests: reemplaza `setTimeout` en las esperas. */
  sleep?: (ms: number) => Promise<void>;
  /** Inyectable para tests: reloj en ms. Default `Date.now`. */
  now?: () => number;
}

export interface RestBucketEstado {
  /** Requests contadas en el bucket al momento de leer el header (incluye la que lo trajo). */
  used: number;
  max: number;
  /** `now()` cuando se leyó. */
  at: number;
}

export interface RestPacer {
  /** Última lectura del bucket, o null si todavía no volvió ninguna respuesta con header. */
  bucket(): RestBucketEstado | null;
  /** Cuántas requests durmieron antes de salir porque el bucket estaba lleno. */
  readonly esperas: number;
  /** Cuántos 429 se reintentaron. */
  readonly reintentos: number;
}

export const RESERVA_DEFAULT = 0.25;
export const MAX_RETRIES_429_DEFAULT = 4;
export const MAX_WAIT_MS_DEFAULT = 30_000;
/** Backoff cuando el 429 viene sin `Retry-After` (no debería pasar; la doc lo manda siempre). */
const BACKOFF_429_MS = [1_000, 2_000, 4_000, 8_000];
/** Tamaño de bucket que se asume si un 429 llega sin header de límite. */
const BUCKET_STANDARD = 40;

const CALL_LIMIT_HEADER = 'x-shopify-shop-api-call-limit';
const RETRY_AFTER_HEADER = 'retry-after';

interface PacedConfig extends InternalAxiosRequestConfig {
  /** Cuántas veces ya se re-emitió esta request por 429. Axios conserva las claves propias al re-emitir. */
  __shopifyPacerIntento?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * En producción `response.headers` es un `AxiosHeaders` (`.get` es
 * case-insensitive); en tests suele ser un objeto plano. Se aceptan los dos.
 */
function leerHeader(headers: unknown, nombre: string): unknown {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as { get?: (n: string) => unknown } & Record<string, unknown>;
  if (typeof h.get === 'function') return h.get(nombre);
  if (nombre in h) return h[nombre];
  const key = Object.keys(h).find((k) => k.toLowerCase() === nombre);
  return key ? h[key] : undefined;
}

/** Requests por segundo que drena el bucket, asumiendo la tasa más lenta para ese tamaño. */
export function drenajePorSegundo(max: number): number {
  return Math.max(2, max / 20);
}

/** `"32/40"` → `{ used: 32, max: 40 }`. Cualquier otra cosa → null. */
export function parseCallLimit(raw: unknown): { used: number; max: number } | null {
  if (typeof raw !== 'string') return null;
  const [used, max] = raw.split('/').map(Number);
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0 || used < 0) return null;
  return { used, max };
}

/** `Retry-After` en segundos (Shopify manda `"2.0"`) → ms. Sin header o ilegible → null. */
export function parseRetryAfterMs(raw: unknown): number | null {
  const secs = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.ceil(secs * 1000);
}

/**
 * Cuánto dormir para que UNA request más (además de las `enVuelo`) entre sin
 * pasar el umbral `max × (1 − reserva)`. 0 si entra ya. Pura, para tests.
 */
export function esperaParaEntrarMs(
  estado: RestBucketEstado | null,
  enVuelo: number,
  reserva: number,
  nowMs: number,
): number {
  if (!estado) return 0;
  const tasa = drenajePorSegundo(estado.max);
  const drenado = (Math.max(0, nowMs - estado.at) / 1000) * tasa;
  const usadoAhora = Math.max(0, estado.used - drenado);
  const umbral = Math.max(1, Math.floor(estado.max * (1 - reserva)));
  const proyectado = usadoAhora + enVuelo + 1;
  if (proyectado <= umbral) return 0;
  return Math.ceil(((proyectado - umbral) / tasa) * 1000);
}

export function installShopifyRestPacer(rest: AxiosInstance, opts: RestPacerOptions = {}): RestPacer {
  const reserva = opts.reserva ?? RESERVA_DEFAULT;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES_429_DEFAULT;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS_DEFAULT;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  let estado: RestBucketEstado | null = null;
  let enVuelo = 0;
  /** Cola de admisión: cada request espera a que la anterior haya decidido salir. */
  let cola: Promise<void> = Promise.resolve();

  const pacer = {
    bucket: () => estado,
    esperas: 0,
    reintentos: 0,
  };

  function registrar(headers: unknown): boolean {
    const leido = parseCallLimit(leerHeader(headers, CALL_LIMIT_HEADER));
    if (!leido) return false;
    estado = { ...leido, at: now() };
    return true;
  }

  rest.interceptors.request.use(async (config) => {
    const turno = cola.then(async () => {
      const ms = esperaParaEntrarMs(estado, enVuelo, reserva, now());
      if (ms > 0) {
        pacer.esperas += 1;
        await sleep(Math.min(ms, maxWaitMs));
      }
      enVuelo += 1;
    });
    cola = turno.catch(() => undefined);
    await turno;
    return config;
  });

  rest.interceptors.response.use(
    (response) => {
      enVuelo = Math.max(0, enVuelo - 1);
      registrar(response.headers);
      return response;
    },
    async (error: AxiosError) => {
      enVuelo = Math.max(0, enVuelo - 1);
      const response = error?.response;
      const config = error?.config as PacedConfig | undefined;
      if (!response || !config) throw error;
      const conHeader = registrar(response.headers);
      if (response.status !== 429) throw error;

      const intento = config.__shopifyPacerIntento ?? 0;
      if (intento >= maxRetries) throw error;

      // Un 429 sin header igual significa bucket lleno: que la admisión lo sepa.
      if (!conHeader) {
        const max = estado?.max ?? BUCKET_STANDARD;
        estado = { used: max, max, at: now() };
      }
      const retryAfter = parseRetryAfterMs(leerHeader(response.headers, RETRY_AFTER_HEADER));
      const ms = Math.min(maxWaitMs, retryAfter ?? BACKOFF_429_MS[Math.min(intento, BACKOFF_429_MS.length - 1)]);
      pacer.reintentos += 1;
      logger.warn(
        { url: config.url, intento: intento + 1, maxRetries, esperaMs: ms, retryAfter: retryAfter != null },
        'Shopify REST 429: esperando y reintentando',
      );
      await sleep(ms);
      config.__shopifyPacerIntento = intento + 1;
      return rest.request(config);
    },
  );

  return pacer;
}
