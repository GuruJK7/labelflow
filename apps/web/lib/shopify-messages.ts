/**
 * Mensajes del ida y vuelta de OAuth con Shopify.
 *
 * Dos pantallas los muestran:
 *   - /settings (rama dashboard): el comerciante está logueado, conectó desde
 *     el botón y vuelve acá.
 *   - /login (rama App Store): NO hay sesión — todo lo que le pase a alguien
 *     que instaló desde el App Store, éxito o error, tiene que aterrizar en
 *     una página pública, y la única que tiene sentido es el login.
 *
 * Cada motivo dice qué pasó Y qué hacer — un "error" a secas en un flujo de
 * conexión termina siempre en un mensaje de WhatsApp.
 */
export interface ShopifyMessage {
  ok: boolean;
  text: string;
}

export const SHOPIFY_OAUTH_MESSAGES: Record<string, ShopifyMessage> = {
  connected: { ok: true, text: 'Tienda conectada. Ya podemos leer tus pedidos y marcarlos como enviados.' },
  bad_shop: { ok: false, text: 'Ese no parece un dominio de Shopify. Tiene que terminar en .myshopify.com.' },
  already_linked: { ok: false, text: 'Esa tienda ya está conectada a otra cuenta. Escribinos y lo resolvemos.' },
  missing_scopes: { ok: false, text: 'Faltaron permisos al autorizar. Volvé a conectar y aceptá todos.' },
  bad_hmac: { ok: false, text: 'No pudimos validar la respuesta de Shopify. Probá de nuevo desde el botón.' },
  bad_state: { ok: false, text: 'La conexión expiró o se abrió en otra pestaña. Probá de nuevo.' },
  bad_flow: { ok: false, text: 'Se mezclaron dos conexiones a la vez. Cerrá las otras pestañas y probá de nuevo.' },
  stale: { ok: false, text: 'La conexión tardó demasiado. Probá de nuevo.' },
  no_session: { ok: false, text: 'Se cerró tu sesión en el medio. Ingresá otra vez y reintentá.' },
  not_owner: { ok: false, text: 'Esa tienda no es tuya. Cambiá de tienda arriba y reintentá.' },
  shop_mismatch: { ok: false, text: 'Este espacio ya está conectado a otra tienda. Para sumar una nueva, creála desde el selector de tiendas y conectala desde ahí.' },
  exchange_failed: { ok: false, text: 'Shopify rechazó la conexión. Probá de nuevo en unos minutos.' },
  no_code: { ok: false, text: 'Shopify no devolvió la autorización. Probá de nuevo.' },
  misconfigured: { ok: false, text: 'La conexión con Shopify no está configurada todavía. Avisanos.' },
  // Reclamo de una instalación del App Store por una cuenta que ya existía.
  claim_expired: { ok: false, text: 'La instalación venció antes de que entraras. Volvé a instalar desde Shopify: son diez segundos.' },
  claim_invalid: { ok: false, text: 'No pudimos leer la instalación pendiente. Volvé a instalar desde Shopify.' },
  claim_failed: { ok: false, text: 'No pudimos vincular la tienda. Probá de nuevo en unos minutos.' },
  // La tienda que se intentó reclamar ya es de un tenant de ESTE usuario (la
  // conectó por Reconectar o con token manual mientras la cookie vivía). No
  // es un error y no hay que escribirle a soporte: está en el selector.
  already_yours: { ok: true, text: 'Esa tienda ya está conectada a tu cuenta: elegila en el selector.' },
};

/**
 * Lo que ve alguien que llega a /login desde el App Store. Los motivos de
 * éxito tienen texto propio; cualquier motivo de error cae en un genérico
 * porque el comerciante todavía no tiene dónde "reintentar" más que Shopify.
 */
export const SHOPIFY_LOGIN_MESSAGES: Record<string, ShopifyMessage> = {
  welcome: {
    ok: true,
    text: 'Tu tienda ya quedó conectada. Te mandamos un mail al email de contacto de tu tienda para que elijas tu contraseña. Cuando la tengas, entrá por acá.',
  },
  claim: {
    ok: true,
    text: 'Ya existe una cuenta con el email de tu tienda. Iniciá sesión para vincular la tienda a tu cuenta.',
  },
  reconnected: {
    ok: true,
    text: 'Tu tienda volvió a quedar conectada. Iniciá sesión para seguir.',
  },
  open: {
    ok: true,
    text: 'Tu tienda ya está conectada a AutoEnvía. Iniciá sesión para ver tus pedidos.',
  },
  // Único error con texto propio: el comerciante SÍ tiene dónde reintentar
  // (la cuenta dueña de la tienda), y el genérico lo mandaría a reinstalar
  // desde Shopify en loop.
  already_linked: {
    ok: false,
    text: 'Esta tienda ya está vinculada a una cuenta. Iniciá sesión con esa cuenta y usá Reconectar en Configuración.',
  },
};

export const SHOPIFY_LOGIN_GENERIC_ERROR: ShopifyMessage = {
  ok: false,
  text: 'No pudimos completar la instalación desde Shopify. Volvé a intentarlo desde tu admin de Shopify y, si sigue fallando, escribinos.',
};

export function shopifyLoginMessage(motivo: string | null | undefined): ShopifyMessage | null {
  if (!motivo) return null;
  return SHOPIFY_LOGIN_MESSAGES[motivo] ?? SHOPIFY_LOGIN_GENERIC_ERROR;
}

/**
 * Handle de tienda que /api/shopify/claim pone en `/settings?shop=<handle>`.
 *
 * Se valida ANTES de renderizarlo porque viene de la URL, o sea de cualquiera:
 * sin esto, el banner verde de "tienda conectada" mostraría el texto que el
 * link traiga ("tienda X quedó conectada: llamá al 099..."). Misma forma que
 * exige `normalizeShopDomain` para el handle (`[a-z0-9][a-z0-9-]*`, sin guión
 * final); no se importa desde `shopify-oauth` porque ese módulo carga `crypto`
 * de Node y esto corre en el cliente.
 */
export function shopHandleFromParam(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 100) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s) || s.endsWith('-')) return null;
  return s;
}

const WEBHOOKS_WARNING_TAIL =
  'No pudimos activar el aviso instantáneo de pedidos nuevos: van a entrar igual, con hasta 15 minutos de demora.';

/**
 * Banner de /settings tras reclamar una tienda desde el App Store. El tenant
 * reclamado NO queda activo (el activo vive en el JWT y sólo lo cambia el
 * TenantSwitcher desde el cliente), así que hay que decir de cuál se habla.
 */
/** Variante de `already_yours` que nombra la tienda cuando /claim mandó el handle. */
export function alreadyYoursMessage(handle: string): ShopifyMessage {
  return { ok: true, text: `La tienda ${handle} ya está conectada a tu cuenta: elegila en el selector.` };
}

export function connectedNewStoreMessage(handle: string, webhooksWarning: boolean): ShopifyMessage {
  const base = `La tienda ${handle} quedó conectada como tienda nueva: elegila en el selector para cargar sus credenciales de DAC.`;
  return {
    ok: true,
    text: webhooksWarning ? `${base} ${WEBHOOKS_WARNING_TAIL}` : base,
  };
}
