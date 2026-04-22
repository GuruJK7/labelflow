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

/**
 * M-7 (2026-04-21 audit): return `YYYY-MM-DD` in a specific IANA
 * timezone.
 *
 * The previous pattern — `new Date().toISOString().split('T')[0]` — is
 * UTC-based. For an operator in Uruguay (UTC-3), an order submitted at
 * 22:00 UY lands in the NEXT day's folder because it's already 01:00 UTC.
 * That breaks "today's labels" ops queries that filter by prefix, and
 * inflates one date bucket while leaving a gap in the adjacent one.
 *
 * Uses `Intl.DateTimeFormat('en-CA', ...)` because the `en-CA` locale
 * natively formats dates as `YYYY-MM-DD`, so no post-parse reassembly is
 * needed. Defaults to America/Montevideo since every tenant is UY-based;
 * callers can pass their own tz when that changes.
 */
export function localYmd(date: Date = new Date(), tz: string = 'America/Montevideo'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
