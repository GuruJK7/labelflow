import { encrypt, decrypt } from '@/lib/encryption';
import { normalizeShopDomain, PENDING_INSTALL_TTL_SECONDS } from '@/lib/shopify-oauth';

/**
 * Instalación pendiente de reclamo (D11).
 *
 * Cuando alguien instala desde el App Store y el email de contacto de la tienda
 * ya tiene cuenta en AutoEnvía, NO le colgamos la tienda a esa cuenta: el token
 * viaja cifrado en una cookie de vida corta hasta que el dueño de la cuenta se
 * loguea y la reclama en /api/shopify/claim. Así no hace falta una tabla nueva
 * (D9: nada de migraciones a prod en el mismo turno) y el token nunca queda
 * suelto en la base sin dueño.
 *
 * Se cifra con la MISMA primitiva que `Tenant.shopifyToken` (AES-256-GCM con
 * ENCRYPTION_KEY): el GCM autentica, así que una cookie editada a mano no
 * descifra y se rechaza. El `iat` va adentro del cifrado, no en claro, para
 * que tampoco se pueda estirar la vida útil desde afuera.
 *
 * SEPARACIÓN DE DOMINIO: el texto plano lleva el prefijo `pending-install:v1:`
 * y `openPendingInstall` lo exige. Misma clave y misma primitiva que otros
 * secretos de la base significa que, sin esto, cualquier ciphertext nuestro
 * (un `shopifyToken`, una `dacPassword`) sería "una cookie pendiente" que
 * descifra bien y sólo falla por la forma del JSON — y la forma es un chequeo
 * mucho más débil que "esto se cifró PARA ser esta cookie". El `v1` deja
 * cambiar el formato sin aceptar cookies viejas.
 */
export const PENDING_INSTALL_PREFIX = 'pending-install:v1:';
export interface PendingInstall {
  shop: string;
  token: string;
  /** Segundos Unix en que se emitió. */
  iat: number;
}

export function sealPendingInstall(input: { shop: string; token: string }, nowMs = Date.now()): string {
  const payload: PendingInstall = {
    shop: input.shop,
    token: input.token,
    iat: Math.floor(nowMs / 1000),
  };
  return encrypt(PENDING_INSTALL_PREFIX + JSON.stringify(payload));
}

/**
 * Descifra y valida. Devuelve null ante CUALQUIER problema: cookie ausente,
 * no descifra, forma inesperada, dominio inválido, o más vieja que el TTL.
 * El llamador no distingue causas a propósito: todas terminan en "volvé a
 * instalar desde Shopify".
 */
export function openPendingInstall(
  value: string | null | undefined,
  nowMs = Date.now(),
  ttlSeconds = PENDING_INSTALL_TTL_SECONDS,
): PendingInstall | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    const plain = decrypt(value);
    // Descifra pero no es de este dominio: un token u otro secreto cifrado
    // con la misma clave. Afuera, igual que basura.
    if (!plain.startsWith(PENDING_INSTALL_PREFIX)) return null;
    parsed = JSON.parse(plain.slice(PENDING_INSTALL_PREFIX.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<PendingInstall>;
  if (typeof p.shop !== 'string' || typeof p.token !== 'string' || typeof p.iat !== 'number') return null;
  if (!p.token) return null;

  const shop = normalizeShopDomain(p.shop);
  if (!shop) return null;

  const ageSeconds = Math.floor(nowMs / 1000) - p.iat;
  // Negativo = emitida "en el futuro": reloj corrido o payload manipulado. Afuera.
  if (ageSeconds < 0 || ageSeconds > ttlSeconds) return null;

  return { shop, token: p.token, iat: p.iat };
}
