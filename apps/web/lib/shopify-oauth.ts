import crypto from 'crypto';

/**
 * OAuth de Shopify — núcleo puro, sin I/O ni acceso a DB.
 *
 * Reemplaza el flujo manual actual (el comerciante crea su propia custom app,
 * copia el Admin API token y lo pega en Settings) por un botón: "Conectar con
 * Shopify" → autoriza → listo.
 *
 * TRES HMAC DISTINTOS, NO CONFUNDIRLOS
 * ------------------------------------
 * Shopify firma tres cosas de tres formas distintas y mezclarlas es el error
 * clásico de esta integración:
 *
 *   1. Webhooks       → HMAC-SHA256 del CUERPO CRUDO, en base64, header
 *                       `x-shopify-hmac-sha256`. Vive en `lib/shopify-webhook.ts`.
 *   2. Callback OAuth → HMAC-SHA256 del QUERY STRING ordenado, en HEX, parámetro
 *                       `hmac`. Es este archivo, `verifyOAuthHmac()`.
 *   3. App proxy      → otro esquema todavía. No lo usamos.
 *
 * Los tres usan el mismo secreto (`SHOPIFY_API_SECRET`, el Client secret del
 * Partner Dashboard), pero sobre entradas y codificaciones diferentes.
 */

/**
 * Scopes que necesita AutoEnvía. Fuente única de verdad.
 *
 * Antes esta lista estaba duplicada en tres lugares
 * (`app/tutorial/shopify-token/page.tsx` dos veces y
 * `app/api/v1/shopify-scopes/route.ts`), lo que garantiza que tarde o temprano
 * se desincronicen y un tenant quede autorizado con menos permisos de los que
 * el worker necesita — falla recién al despachar, no al conectar.
 *
 * Por qué cada uno:
 *   read_orders / write_orders  → leer pedidos pagos y escribir notas/tags.
 *   read_fulfillments / write_fulfillments → marcar el pedido como enviado.
 *   read_products / write_products → resolver SKU y tipo de producto.
 *   *_fulfillment_orders → la API moderna de fulfillment; sin estos, marcar
 *     como enviado falla en tiendas nuevas aunque write_fulfillments esté.
 */
export const REQUIRED_SCOPES = [
  'read_orders',
  'write_orders',
  'read_fulfillments',
  'write_fulfillments',
  'read_products',
  'write_products',
  'read_assigned_fulfillment_orders',
  'write_assigned_fulfillment_orders',
  'read_merchant_managed_fulfillment_orders',
  'write_merchant_managed_fulfillment_orders',
] as const;

export const SCOPES_PARAM = REQUIRED_SCOPES.join(',');

/**
 * Dominios de tienda válidos. Deliberadamente estricto.
 *
 * ESTA FUNCIÓN ES LA DEFENSA PRINCIPAL DEL FLUJO. El parámetro `shop` viene del
 * usuario y termina dentro de una URL a la que redirigimos y contra la que
 * hacemos POST del `code`. Si se cuela cualquier host, se convierte en:
 *   - open redirect (mandamos al usuario a un sitio del atacante), y
 *   - SSRF con credenciales (posteamos el client_secret a un host ajeno).
 *
 * Por eso: sólo `<tienda>.myshopify.com`, minúsculas, sin credenciales, sin
 * puerto, sin subdominios extra. Cualquier otra cosa devuelve null.
 */
export function normalizeShopDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  // ¿Vino como URL o como texto suelto? Cambia si podemos completar el sufijo.
  const vinoComoUrl = s.includes('://');

  // Aceptamos que peguen la URL entera del admin.
  if (vinoComoUrl) {
    // Rechazar credenciales embebidas ANTES de parsear. `new URL()` las
    // descarta silenciosamente y devuelve el host limpio, así que un chequeo
    // posterior sobre el hostname nunca las vería. No es explotable con este
    // código —reconstruimos la URL desde cero— pero una entrada así nunca es
    // legítima, y la estrictez acá protege de un refactor futuro que use el
    // string original en vez del normalizado.
    const sinEsquema = s.slice(s.indexOf('://') + 3);
    const finAutoridad = sinEsquema.search(/[/?#]/);
    const autoridad = finAutoridad === -1 ? sinEsquema : sinEsquema.slice(0, finAutoridad);
    if (autoridad.includes('@')) return null;
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else {
    // Cortar path, query y fragment si pegaron "acme.myshopify.com/admin".
    s = s.split('/')[0].split('?')[0].split('#')[0];
  }

  // Rechazar credenciales embebidas y puertos antes de mirar la forma.
  if (s.includes('@') || s.includes(':')) return null;

  // Escribieron sólo el handle ("acme"). Completamos el sufijo por comodidad.
  //
  // SÓLO si NO vino como URL. Si vino como URL, el hostname es lo que es: con
  // `http://localhost/acme.myshopify.com` el hostname es `localhost`, y
  // completarlo daría `localhost.myshopify.com` — un dominio inventado a partir
  // de una entrada que no era una tienda. Ahí hay que rechazar, no completar.
  if (!s.includes('.')) {
    if (vinoComoUrl) return null;
    s = `${s}.myshopify.com`;
  }

  // Exactamente un subdominio, y el handle con la forma que permite Shopify.
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return null;
  // Un handle no puede terminar en guión.
  if (s.split('.')[0].endsWith('-')) return null;
  // Longitud defensiva: Shopify topea bastante antes, esto sólo evita abusos.
  if (s.length > 100) return null;

  return s;
}

/** Nonce anti-CSRF para el parámetro `state`. */
export function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Comparación en tiempo constante de dos `state`. */
export function statesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface AuthorizeUrlInput {
  shop: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string;
  /** true para token offline (el que queremos: sirve sin el comerciante presente). */
  online?: boolean;
}

/**
 * Construye la URL de autorización de Shopify.
 *
 * Pedimos token OFFLINE (sin `grant_options[]=per-user`): el worker despacha a
 * las 3 de la mañana sin nadie logueado. Un token online expira con la sesión
 * del comerciante y rompería el cron.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const shop = normalizeShopDomain(input.shop);
  if (!shop) throw new Error(`Dominio de tienda inválido: ${input.shop}`);
  if (!input.clientId) throw new Error('Falta clientId');
  if (!input.state) throw new Error('Falta state');
  assertHttpsUrl(input.redirectUri);

  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: input.scopes ?? SCOPES_PARAM,
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  if (input.online) params.set('grant_options[]', 'per-user');

  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * Verifica el HMAC del callback de OAuth.
 *
 * Algoritmo de Shopify: sacar `hmac` (y `signature`, legacy) del query, ordenar
 * las claves restantes alfabéticamente, unir como `k=v&k=v`, HMAC-SHA256 con el
 * client secret, comparar en hex.
 *
 * Fail-closed sin secreto, igual que el verificador de webhooks: si falta la
 * env var preferimos rechazar todas las instalaciones antes que aceptar
 * cualquiera.
 */
export function verifyOAuthHmac(
  params: URLSearchParams | Record<string, string>,
  secret: string | undefined = process.env.SHOPIFY_API_SECRET,
): boolean {
  if (!secret) return false;

  const entries: Array<[string, string]> =
    params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);

  let provided: string | null = null;
  const rest: Array<[string, string]> = [];
  for (const [k, v] of entries) {
    if (k === 'hmac') {
      provided = v;
      continue;
    }
    if (k === 'signature') continue; // legacy, excluido del cálculo
    rest.push([k, v]);
  }
  if (!provided) return false;

  rest.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const message = rest.map(([k, v]) => `${k}=${v}`).join('&');

  const digest = crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');

  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * ¿Los scopes que devolvió Shopify alcanzan para operar?
 * Se compara como conjunto: Shopify puede devolverlos en otro orden, y puede
 * incluir scopes implicados que no pedimos.
 */
export function missingScopes(granted: string | string[] | null | undefined): string[] {
  const set = new Set(
    (typeof granted === 'string' ? granted.split(',') : (granted ?? [])).map((s) => s.trim()).filter(Boolean),
  );
  return REQUIRED_SCOPES.filter((s) => !set.has(s));
}

/** La URL a la que Shopify devuelve tras autorizar. Debe estar declarada en el Partner Dashboard. */
export function callbackUrl(appUrl: string): string {
  return `${stripTrailingSlash(appUrl)}/api/shopify/callback`;
}

function stripTrailingSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

function assertHttpsUrl(u: string): void {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`redirectUri inválida: ${u}`);
  }
  // Shopify exige https salvo en localhost para desarrollo.
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new Error(`redirectUri debe ser https: ${u}`);
  }
}

/** Nombre de la cookie donde viaja el state entre install y callback. */
export const STATE_COOKIE = 'shopify_oauth_state';
/** Nombre de la cookie con el tenant que inició la conexión. */
export const TENANT_COOKIE = 'shopify_oauth_tenant';
/** Vida corta: el usuario va y vuelve de Shopify en segundos. */
export const STATE_TTL_SECONDS = 600;
