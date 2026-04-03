/**
 * Recover module utilities.
 * Phone normalization, template interpolation, and helpers.
 */

/**
 * Normalizes a phone number to E.164 format for Uruguay and LATAM.
 * Accepts: 091234567, +59891234567, 59891234567, 098123456
 * Returns null if the input cannot be normalized.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')

  if (digits.length === 0) return null

  // Uruguay mobile: 09X followed by 6-7 digits (total 9 digits)
  if (digits.startsWith('0') && digits.length === 9) {
    return `+598${digits.slice(1)}`
  }

  // Already has country code (10-13 digits)
  if (digits.length >= 10 && digits.length <= 13) {
    return `+${digits}`
  }

  // 8-digit Uruguay number without leading 0
  if (digits.length === 8 && (digits.startsWith('9') || digits.startsWith('2'))) {
    return `+598${digits}`
  }

  return null
}

/**
 * Masks a phone number for display and logging.
 * +59891234567 -> +598 91*****67
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '***'
  if (phone.length < 8) return '***'
  const prefix = phone.slice(0, 6)
  const suffix = phone.slice(-2)
  const masked = '*'.repeat(Math.max(phone.length - 8, 3))
  return `${prefix}${masked}${suffix}`
}

/**
 * Interpolates template variables.
 * Variables: {{1}} = customer first name, {{2}} = product name, {{3}} = checkout URL
 */
export function interpolateTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return Object.entries(vars).reduce(
    (msg, [key, value]) => msg.replaceAll(key, value),
    template
  )
}

/**
 * Builds a Shopify checkout recovery URL.
 */
export function buildCheckoutUrl(
  shopDomain: string,
  checkoutToken: string
): string {
  return `https://${shopDomain}/checkouts/${checkoutToken}`
}

/**
 * Extracts the first name from a full name string.
 * Falls back to 'cliente' if empty.
 */
export function extractFirstName(fullName: string | null | undefined): string {
  if (!fullName || fullName.trim().length === 0) return 'cliente'
  return fullName.trim().split(/\s+/)[0] ?? 'cliente'
}
