/**
 * Masks an email for safe logging: us***@gmail.com
 */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***@***';
  return `${user.substring(0, 2)}***@${domain}`;
}

/**
 * Cleans a phone number to digits only. Returns fallback if empty.
 */
export function cleanPhone(phone: string | null | undefined): string {
  if (!phone) return '099000000';
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.length >= 6 ? cleaned : '099000000';
}

/**
 * Sleep utility.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Masks a token for safe logging: shpat_***
 */
export function maskToken(token: string): string {
  if (token.length <= 6) return '***';
  return `${token.substring(0, 6)}***`;
}

/**
 * Formats duration in ms to human-readable.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}
