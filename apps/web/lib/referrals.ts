/**
 * Sistema de referidos. Cada tenant tiene un `referralCode` único corto
 * (ej. "JK7-A4F2") que comparte como `https://app/signup?ref=<code>`.
 *
 * Flujo de atribución:
 *   1. Usuario llega a /signup?ref=<code>. La página guarda el código en
 *      una cookie firmada (HMAC sha256) por 30 días.
 *   2. Al hacer POST /api/auth/signup, el handler lee la cookie, valida
 *      la firma, busca el Tenant con ese referralCode y setea
 *      `Tenant.referredByCode` + `Tenant.referredById` del nuevo tenant.
 *   3. Cuando el referido COMPRA un pack (no por usar los 10 gratis),
 *      el webhook de MP crea una ReferralCreditAccrual y le suma al
 *      referidor floor(0.2 * shipments) envíos a su saldo.
 *
 * La cookie es firmada para evitar que alguien la edite a mano y
 * atribuya su signup a un código falso. Si la firma no valida, se ignora.
 */

import crypto from 'crypto';

const COOKIE_NAME = 'lf_ref';
const COOKIE_MAX_AGE_DAYS = 30;
const REFERRAL_CODE_REGEX = /^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/;

/**
 * Genera un código de referido único derivado del slug del tenant.
 * Formato: <PREFIX>-<RANDOM>, ej. "JK7-A4F2".
 *
 * El prefijo se toma del slug (alfanumérico, mayúsculas) para que sea
 * memorable; el sufijo es aleatorio para evitar colisiones. La unicidad
 * la enforce el constraint de Prisma — el caller debe reintentar si hay
 * colisión (raras veces; el espacio es 16^4 = 65k por prefijo).
 */
export function generateReferralCode(slug: string): string {
  const prefix = slug
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase()
    .padEnd(2, 'X')
    .slice(0, 4);
  const random = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${random}`;
}

/**
 * Valida la forma del código (no su existencia en DB) — útil para
 * rechazar payloads inválidos antes de hacer un query.
 */
export function isValidReferralCodeShape(code: string | null | undefined): boolean {
  if (!code) return false;
  return REFERRAL_CODE_REGEX.test(code);
}

// ── Cookie firmada para atribución cross-pageload ──

function getCookieSecret(): string {
  // Reusamos NEXTAUTH_SECRET como base — es obligatorio en prod y rotarlo
  // invalida cookies de referido (aceptable: 30 días max de TTL).
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    // No throw: en dev sin NEXTAUTH_SECRET, la cookie queda firmada con
    // un literal — el referido no se atribuye correctamente, pero el
    // resto del signup sigue funcionando.
    return 'dev-fallback-secret-do-not-use-in-prod';
  }
  return secret;
}

function sign(value: string): string {
  return crypto
    .createHmac('sha256', getCookieSecret())
    .update(value)
    .digest('hex')
    .slice(0, 16); // 64 bits es suficiente para una cookie no-criptográfica
}

/**
 * Construye el value de la cookie: `<code>.<sig>`. La página de signup la
 * setea con `document.cookie = ...; max-age=...; path=/; samesite=lax`.
 */
export function buildReferralCookieValue(code: string): string | null {
  if (!isValidReferralCodeShape(code)) return null;
  return `${code}.${sign(code)}`;
}

/**
 * Lee y valida un valor de cookie. Devuelve el código si la firma es
 * válida, null en cualquier otro caso (ataque, cookie vieja, etc.).
 */
export function readReferralCookieValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;
  const code = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  if (!isValidReferralCodeShape(code)) return null;
  if (sign(code) !== sig) return null;
  return code;
}

export const REFERRAL_COOKIE_NAME = COOKIE_NAME;
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;
