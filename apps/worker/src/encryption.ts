import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is required');
  return Buffer.from(key, 'hex');
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Output format matches the web app's helper (apps/web/lib/encryption.ts):
 *   iv_hex:tag_hex:ciphertext_hex
 * so worker-encrypted values can be decrypted server-side (and vice-versa)
 * as long as both processes read the same ENCRYPTION_KEY.
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

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const [ivHex, tagHex, encryptedHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !encryptedHex) throw new Error('Invalid encrypted format');

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function encryptIfPresent(value: string | null | undefined): string | null {
  if (!value || value.trim() === '') return null;
  return encrypt(value);
}

export function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

/**
 * Backward-compatible decrypt for fields being migrated to encryption at rest
 * (e.g. dacUsername). Returns decrypted plaintext for encrypted rows, or the
 * raw value for legacy plaintext rows not yet re-saved through the settings UI.
 *
 * See apps/web/lib/encryption.ts for full rationale.
 */
export function decryptOrRaw(value: string | null | undefined): string | null {
  if (!value || value.trim() === '') return null;

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
      // Decryption failed (wrong key, tampered data). Return null so the
      // caller gets a clear "missing credential" error rather than trying
      // to use the raw ciphertext as a DAC username.
      return null;
    }
  }

  // Not in encrypted format — treat as legacy plaintext value.
  return value;
}
