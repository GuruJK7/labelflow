import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY is required. Generate with: openssl rand -hex 32'
    );
  }
  return Buffer.from(key, 'hex');
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns format: iv_hex:tag_hex:ciphertext_hex
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts ciphertext in format iv_hex:tag_hex:ciphertext_hex.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format');
  }

  const [ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Encrypts a value only if it's a non-empty string.
 * Returns null if input is null/undefined/empty.
 */
export function encryptIfPresent(value: string | null | undefined): string | null {
  if (!value || value.trim() === '') return null;
  return encrypt(value);
}

/**
 * Decrypts a value only if it's a non-empty encrypted string.
 * Returns null if input is null/undefined/empty.
 */
export function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value || value.trim() === '') return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

/**
 * Backward-compatible decrypt: returns the plaintext for encrypted values,
 * or the raw string for legacy plaintext values not yet encrypted at rest.
 *
 * Used for fields that are being migrated to encryption (e.g. dacUsername).
 * Distinguishes encrypted format by checking for the iv:tag:ciphertext hex
 * structure before attempting decryption. This lets us:
 *   - Return the plaintext for already-encrypted DB rows (decrypt path).
 *   - Return the value as-is for old rows written before encryption was
 *     added (plaintext path) so the migration can be zero-downtime.
 *
 * Once all rows in the DB have been migrated (re-saved via the settings UI)
 * this helper can be replaced with a plain `decryptIfPresent` call.
 */
export function decryptOrRaw(value: string | null | undefined): string | null {
  if (!value || value.trim() === '') return null;

  // Heuristic: encrypted format is exactly 3 colon-separated hex strings.
  // iv (32 hex chars for 16 bytes) : tag (32 hex chars) : ciphertext (any hex)
  const parts = value.split(':');
  if (
    parts.length === 3 &&
    /^[0-9a-f]{32}$/i.test(parts[0]) &&
    /^[0-9a-f]{32}$/i.test(parts[1]) &&
    /^[0-9a-f]+$/i.test(parts[2])
  ) {
    try {
      return decrypt(value);
    } catch {
      // Looks like encrypted format but decryption failed (wrong key, tampered
      // ciphertext, etc.). Return null so callers surface a clear
      // "credential missing" error rather than attempting to use the raw
      // ciphertext as a password, which produces a confusing downstream failure.
      return null;
    }
  }

  // Not in encrypted format — treat as legacy plaintext value.
  return value;
}
