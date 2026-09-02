import { encrypt, decryptIfPresent } from '../encryption';

/**
 * Tokens offline EXPIRABLES de la app pública de Shopify (D29).
 *
 * EL HECHO (2026-09-01, logs de producción): con el token del install de la
 * app pública, `shop {}` por GraphQL responde 403 "Non-expiring access tokens
 * are no longer accepted for the Admin API. Start using expiring offline
 * tokens". La app exige tokens que vencen: access 1 h, refresh 90 días, y
 * CADA refresh rota el par (el refresh viejo deja de servir en el acto).
 *
 * SIN MIGRACIÓN: el par entero viaja cifrado en `Tenant.shopifyToken`, la
 * misma columna de siempre. El texto plano es un JSON v1:
 *
 *   {"v":1,"access":"shpat_…","exp":<epoch ms>,"refresh":"shprt_…","refreshExp":<epoch ms>}
 *
 * Un texto plano que NO empieza con `{` es un token legacy (custom app, no
 * vence) y se usa tal cual: los clientes actuales no cambian ni una línea de
 * comportamiento.
 *
 * RENOVACIÓN BAJO DEMANDA (no hay cron sub-diario en Vercel Hobby): quien
 * necesita el token llama a `getValidShopifyAccessToken`; si vence en menos
 * de 5 minutos y el proceso tiene el secret, se refresca y se persiste el par
 * nuevo ANTES de devolverlo. La persistencia es optimista: `UPDATE … WHERE id
 * = ? AND shopifyToken = <cifrado que leí>`. 0 filas = otro proceso ya rotó
 * (o un reinstall escribió un par nuevo): se relee y se usa lo que haya, sin
 * pisarlo. Un `invalid_grant` con la base sin cambios significa que el
 * refresh guardado ya no sirve (huérfano por un fallo de red después de que
 * Shopify rotó, o revocado): NO se borra el token, se loguea "la tienda tiene
 * que reinstalar la app" y se devuelve null.
 *
 * NINGUNA función de este módulo loguea tokens, ni completos ni truncados.
 */

export const SHOPIFY_TOKEN_ENVELOPE_VERSION = 1;
export const SHOPIFY_TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
export const SHOPIFY_REFRESH_TIMEOUT_MS = 15_000;

/** Mensaje accionable para el operador cuando el par guardado ya no se puede renovar. */
export const SHOPIFY_TOKEN_REINSTALL_MESSAGE =
  'El token de Shopify venció y no se pudo renovar: la tienda tiene que reinstalar la app (Settings → Reconectar con Shopify).';

export interface ShopifyCredential {
  access: string;
  /** Vencimiento del access token, epoch ms. Ausente en legacy. */
  exp?: number;
  refresh?: string;
  /** Vencimiento del refresh token, epoch ms. */
  refreshExp?: number;
  /** true = token de custom app que no vence; se usa tal cual. */
  legacy: boolean;
}

/**
 * Texto plano de `Tenant.shopifyToken` → credencial. `null` sólo si el texto
 * es un envelope corrupto (empieza con `{` pero no es el JSON v1 esperado):
 * un token legacy nunca falla acá.
 */
export function parseShopifyCredential(plain: string | null | undefined): ShopifyCredential | null {
  if (!plain || plain.trim() === '') return null;
  if (!plain.startsWith('{')) return { access: plain, legacy: true };
  let raw: unknown;
  try {
    raw = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== SHOPIFY_TOKEN_ENVELOPE_VERSION) return null;
  if (typeof o.access !== 'string' || !o.access) return null;
  const cred: ShopifyCredential = { access: o.access, legacy: false };
  if (typeof o.exp === 'number' && Number.isFinite(o.exp)) cred.exp = o.exp;
  if (typeof o.refresh === 'string' && o.refresh) cred.refresh = o.refresh;
  if (typeof o.refreshExp === 'number' && Number.isFinite(o.refreshExp)) cred.refreshExp = o.refreshExp;
  return cred;
}

/** Credencial → texto plano a cifrar. Legacy vuelve a ser el token pelado. */
export function serializeShopifyCredential(cred: ShopifyCredential): string {
  if (cred.legacy) return cred.access;
  const envelope: Record<string, unknown> = { v: SHOPIFY_TOKEN_ENVELOPE_VERSION, access: cred.access };
  if (cred.exp !== undefined) envelope.exp = cred.exp;
  if (cred.refresh !== undefined) envelope.refresh = cred.refresh;
  if (cred.refreshExp !== undefined) envelope.refreshExp = cred.refreshExp;
  return JSON.stringify(envelope);
}

/**
 * Respuesta del canje (`expiring: '1'`) o del refresh → credencial. Si Shopify
 * no devuelve `refresh_token` (app vieja sin tokens expirables) el access se
 * trata como legacy: se guarda pelado y nunca se intenta renovar.
 */
export function credentialFromTokenResponse(
  json: {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  },
  now = Date.now(),
): ShopifyCredential {
  if (!json.refresh_token) return { access: json.access_token, legacy: true };
  const cred: ShopifyCredential = { access: json.access_token, refresh: json.refresh_token, legacy: false };
  if (typeof json.expires_in === 'number') cred.exp = now + json.expires_in * 1000;
  if (typeof json.refresh_token_expires_in === 'number') {
    cred.refreshExp = now + json.refresh_token_expires_in * 1000;
  }
  return cred;
}

/** true si el access vence dentro de `skewMs` (o ya venció). Legacy nunca vence. */
export function isExpiringSoon(cred: ShopifyCredential, now = Date.now(), skewMs = SHOPIFY_TOKEN_EXPIRY_SKEW_MS): boolean {
  if (cred.legacy || cred.exp === undefined) return false;
  return cred.exp - now <= skewMs;
}

export class ShopifyRefreshError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ShopifyRefreshError';
  }
}
/** 400/401 con `invalid_grant` o "token inválido": el refresh guardado ya no sirve. */
export class ShopifyRefreshInvalidGrant extends ShopifyRefreshError {
  constructor(status: number) {
    super(`Shopify rechazó el refresh token (HTTP ${status})`, status);
    this.name = 'ShopifyRefreshInvalidGrant';
  }
}
/** Red, timeout, 429 o 5xx: reintentable, el par guardado puede seguir sirviendo. */
export class ShopifyRefreshTransient extends ShopifyRefreshError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = 'ShopifyRefreshTransient';
  }
}

const INVALID_GRANT_PATTERN = /invalid_grant|invalid[\s_-]*(refresh[\s_-]*)?token|token[\s_-]*(is[\s_-]*)?invalid/i;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * POST https://{shop}/admin/oauth/access_token con grant_type=refresh_token
 * (shopify.dev, offline-access-tokens). Devuelve el par NUEVO; el llamador
 * es responsable de persistirlo antes de usarlo, porque Shopify ya invalidó
 * el refresh viejo cuando esta función retorna.
 */
export async function refreshShopifyCredential(input: {
  shop: string;
  refresh: string;
  clientId: string;
  secret: string;
  fetchImpl?: FetchLike;
  now?: number;
  timeoutMs?: number;
}): Promise<ShopifyCredential> {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = input.now ?? Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`https://${input.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.secret,
        grant_type: 'refresh_token',
        refresh_token: input.refresh,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? SHOPIFY_REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    throw new ShopifyRefreshTransient(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }

  if (res.status >= 500 || res.status === 429) {
    throw new ShopifyRefreshTransient(`HTTP ${res.status}`, res.status);
  }
  if (res.status === 400 || res.status === 401) {
    const body = await res.text().catch(() => '');
    if (INVALID_GRANT_PATTERN.test(body)) throw new ShopifyRefreshInvalidGrant(res.status);
    throw new ShopifyRefreshError(`HTTP ${res.status} al renovar el token`, res.status);
  }
  if (!res.ok) throw new ShopifyRefreshError(`HTTP ${res.status} al renovar el token`, res.status);

  let json: {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  };
  try {
    json = await res.json();
  } catch {
    throw new ShopifyRefreshTransient('respuesta no es JSON', res.status);
  }
  if (!json.access_token) throw new ShopifyRefreshError('respuesta sin access_token', res.status);
  return credentialFromTokenResponse(
    {
      access_token: json.access_token,
      expires_in: json.expires_in,
      refresh_token: json.refresh_token,
      refresh_token_expires_in: json.refresh_token_expires_in,
    },
    now,
  );
}

/** Lo mínimo que se necesita de Prisma: el UPDATE condicional y la relectura. */
export interface ShopifyTokenDb {
  tenant: {
    updateMany(args: {
      where: { id: string; shopifyToken: string };
      data: { shopifyToken: string };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: { shopifyToken: true };
    }): Promise<{ shopifyToken: string | null } | null>;
  };
}

export interface ShopifyTokenTenant {
  id: string;
  shopifyStoreUrl: string | null;
  shopifyToken: string | null;
}

export type ShopifyAccessResolution =
  | { access: string; reason: null }
  | {
      access: null;
      /** `no-token`: columna vacía · `unreadable`: no descifra o envelope corrupto · `reinstall`: el refresh ya no sirve · `refresh-failed`: fallo transitorio con el access ya vencido. */
      reason: 'no-token' | 'unreadable' | 'reinstall' | 'refresh-failed';
      message: string;
    };

const LOG_PREFIX = '[shopify/token]';
/** Un aviso por tenant por proceso cuando falta el secret: el worker no lo tiene hoy en Render. */
const warnedWithoutSecret = new Set<string>();
/** Un solo refresh por tenant a la vez dentro del proceso: dos rutas concurrentes comparten la promesa. */
const inflight = new Map<string, Promise<ShopifyAccessResolution>>();

/** Sólo para tests: borra el estado por proceso. */
export function __resetShopifyTokenState(): void {
  warnedWithoutSecret.clear();
  inflight.clear();
}

/**
 * Access token listo para usar, o null con el motivo (ver `ShopifyAccessResolution`).
 * Es la versión de `getValidShopifyAccessToken` para quien tiene que escribir
 * el motivo en un runlog (los jobs del worker).
 */
export async function resolveShopifyAccessToken(input: {
  db: ShopifyTokenDb;
  tenant: ShopifyTokenTenant;
  clientId?: string | null;
  secret?: string | null;
  now?: number;
  fetchImpl?: FetchLike;
}): Promise<ShopifyAccessResolution> {
  const { tenant } = input;
  const cipher = tenant.shopifyToken;
  if (!cipher) return { access: null, reason: 'no-token', message: 'Shopify no está conectado en esta tienda' };

  const cred = parseShopifyCredential(decryptIfPresent(cipher));
  if (!cred) {
    console.error(`${LOG_PREFIX} token ilegible`, { tenantId: tenant.id });
    return { access: null, reason: 'unreadable', message: 'El token de Shopify guardado no se puede leer: reconectar la tienda' };
  }
  if (cred.legacy) return { access: cred.access, reason: null };

  const now = input.now ?? Date.now();
  if (!isExpiringSoon(cred, now)) return { access: cred.access, reason: null };

  if (!input.clientId || !input.secret) {
    if (!warnedWithoutSecret.has(tenant.id)) {
      warnedWithoutSecret.add(tenant.id);
      console.warn(
        `${LOG_PREFIX} SHOPIFY_API_KEY/SHOPIFY_API_SECRET no están en el entorno: no se puede renovar el token de Shopify, se usa el guardado (puede estar vencido)`,
        { tenantId: tenant.id },
      );
    }
    return { access: cred.access, reason: null };
  }

  const pending = inflight.get(tenant.id);
  if (pending) return pending;
  const p = renovar({ ...input, cred, cipher, now, clientId: input.clientId, secret: input.secret }).finally(() => {
    inflight.delete(tenant.id);
  });
  inflight.set(tenant.id, p);
  return p;
}

async function renovar(input: {
  db: ShopifyTokenDb;
  tenant: ShopifyTokenTenant;
  cred: ShopifyCredential;
  cipher: string;
  clientId: string;
  secret: string;
  now: number;
  fetchImpl?: FetchLike;
}): Promise<ShopifyAccessResolution> {
  const { db, tenant, cred, cipher, now } = input;
  const vencido = cred.exp !== undefined && cred.exp <= now;

  if (!tenant.shopifyStoreUrl || !cred.refresh) {
    // Sin tienda o sin refresh no hay forma de renovar. Si el access todavía
    // sirve se usa; si no, es un reinstall.
    if (!vencido) return { access: cred.access, reason: null };
    console.error(`${LOG_PREFIX} access vencido y sin refresh token: ${SHOPIFY_TOKEN_REINSTALL_MESSAGE}`, {
      tenantId: tenant.id,
      shop: tenant.shopifyStoreUrl,
    });
    return { access: null, reason: 'reinstall', message: SHOPIFY_TOKEN_REINSTALL_MESSAGE };
  }

  let nuevo: ShopifyCredential;
  try {
    nuevo = await refreshShopifyCredential({
      shop: tenant.shopifyStoreUrl,
      refresh: cred.refresh,
      clientId: input.clientId,
      secret: input.secret,
      fetchImpl: input.fetchImpl,
      now,
    });
  } catch (err) {
    if (err instanceof ShopifyRefreshInvalidGrant) {
      // Alguien más pudo haber rotado (Shopify invalida el refresh viejo en
      // el acto). Si la base cambió, ese par es el bueno; si no, el guardado
      // quedó huérfano y sólo un reinstall lo arregla. Nunca se borra.
      const releido = await releer(db, tenant.id);
      if (releido && releido.cipher !== cipher && releido.cred) {
        return { access: releido.cred.access, reason: null };
      }
      console.error(`${LOG_PREFIX} refresh rechazado (invalid_grant): ${SHOPIFY_TOKEN_REINSTALL_MESSAGE}`, {
        tenantId: tenant.id,
        shop: tenant.shopifyStoreUrl,
        status: err.status,
      });
      return { access: null, reason: 'reinstall', message: SHOPIFY_TOKEN_REINSTALL_MESSAGE };
    }
    const e = err as ShopifyRefreshError;
    console.warn(`${LOG_PREFIX} no se pudo renovar el token (${e.name}: ${e.message})`, {
      tenantId: tenant.id,
      shop: tenant.shopifyStoreUrl,
      status: e.status,
      accessVencido: vencido,
    });
    if (!vencido) return { access: cred.access, reason: null };
    return {
      access: null,
      reason: 'refresh-failed',
      message: `No se pudo renovar el token de Shopify (${e.message}); se reintenta en la próxima corrida`,
    };
  }

  // Persistir ANTES de usar: Shopify ya rotó, el refresh viejo no sirve más.
  const nuevoCipher = encrypt(serializeShopifyCredential(nuevo));
  const r = await updateConReintento(db, tenant.id, cipher, nuevoCipher);
  if (r === 'db-error') {
    // El par nuevo es válido pero no quedó guardado: esta corrida sirve, la
    // próxima va a caer en invalid_grant → reinstall. Queda dicho en el log.
    console.error(`${LOG_PREFIX} el token se renovó pero no se pudo persistir (dos intentos); la próxima renovación va a fallar`, {
      tenantId: tenant.id,
    });
    return { access: nuevo.access, reason: null };
  }
  if (r.count === 1) return { access: nuevo.access, reason: null };

  // 0 filas: el cifrado que leí ya no está (otro proceso rotó, un reinstall
  // escribió un par nuevo, o uninstalled lo puso en null). Lo que haya en la
  // base manda; no se pisa.
  const releido = await releer(db, tenant.id);
  if (releido?.cred) return { access: releido.cred.access, reason: null };
  if (releido && releido.cipher === null) {
    return { access: null, reason: 'no-token', message: 'Shopify se desconectó de esta tienda durante la renovación' };
  }
  // Cambió a algo ilegible, o el tenant desapareció: se usa el par recién
  // emitido, que es válido aunque no haya quedado guardado.
  console.error(`${LOG_PREFIX} la base cambió durante la renovación y lo nuevo no se puede leer; se usa el par recién emitido`, {
    tenantId: tenant.id,
  });
  return { access: nuevo.access, reason: null };
}

async function updateConReintento(
  db: ShopifyTokenDb,
  id: string,
  cipher: string,
  nuevoCipher: string,
): Promise<{ count: number } | 'db-error'> {
  for (let intento = 0; intento < 2; intento++) {
    try {
      return await db.tenant.updateMany({
        where: { id, shopifyToken: cipher },
        data: { shopifyToken: nuevoCipher },
      });
    } catch (err) {
      console.warn(`${LOG_PREFIX} falló el UPDATE del token (intento ${intento + 1})`, {
        tenantId: id,
        message: String((err as { message?: unknown })?.message ?? '').split('\n')[0].slice(0, 200),
      });
    }
  }
  return 'db-error';
}

async function releer(
  db: ShopifyTokenDb,
  id: string,
): Promise<{ cipher: string | null; cred: ShopifyCredential | null } | null> {
  const row = await db.tenant.findUnique({ where: { id }, select: { shopifyToken: true } });
  if (!row) return null;
  const cipher = row.shopifyToken;
  return { cipher, cred: cipher ? parseShopifyCredential(decryptIfPresent(cipher)) : null };
}

/**
 * Access token listo para usar, o null. Para un tenant legacy es exactamente
 * `decryptIfPresent(tenant.shopifyToken)`; para uno del App Store renueva
 * bajo demanda (ver cabecera).
 */
export async function getValidShopifyAccessToken(input: {
  db: ShopifyTokenDb;
  tenant: ShopifyTokenTenant;
  clientId?: string | null;
  secret?: string | null;
  now?: number;
  fetchImpl?: FetchLike;
}): Promise<string | null> {
  return (await resolveShopifyAccessToken(input)).access;
}
