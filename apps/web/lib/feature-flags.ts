/**
 * Feature flags system.
 * Controls which modules are visible/enabled per environment.
 *
 * Set NEXT_PUBLIC_FEATURE_FLAGS env var as comma-separated list:
 *   Production: NEXT_PUBLIC_FEATURE_FLAGS=dac
 *   Staging:    NEXT_PUBLIC_FEATURE_FLAGS=dac,ads,recover
 *
 * If not set, defaults to all features enabled (dev mode).
 */

export type FeatureFlag = 'dac' | 'ads' | 'recover' | 'billing' | 'reports' | 'chat';

const ALL_FLAGS: FeatureFlag[] = ['dac', 'ads', 'recover', 'billing', 'reports', 'chat'];

let cachedFlags: Set<FeatureFlag> | null = null;

function parseFlags(): Set<FeatureFlag> {
  if (cachedFlags) return cachedFlags;

  const raw = process.env.NEXT_PUBLIC_FEATURE_FLAGS;

  // If not set, enable everything (dev mode)
  if (!raw || raw.trim() === '') {
    cachedFlags = new Set(ALL_FLAGS);
    return cachedFlags;
  }

  const flags = raw
    .split(',')
    .map((f) => f.trim().toLowerCase())
    .filter((f): f is FeatureFlag => ALL_FLAGS.includes(f as FeatureFlag));

  cachedFlags = new Set(flags);
  return cachedFlags;
}

/**
 * Check if a feature is enabled in the current environment.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return parseFlags().has(flag);
}

/**
 * Get all enabled feature flags.
 */
export function getEnabledFeatures(): FeatureFlag[] {
  return ALL_FLAGS.filter((f) => parseFlags().has(f));
}

/**
 * Map of sidebar sections to their required feature flag.
 */
export const SECTION_FLAGS: Record<string, FeatureFlag> = {
  'META ADS': 'ads',
  'RECOVER': 'recover',
};

/**
 * Map of individual sidebar item hrefs to their required feature flag.
 * Used for items inside sections that are otherwise enabled.
 */
export const ITEM_FLAGS: Record<string, FeatureFlag> = {
  '/reports': 'reports',
};
