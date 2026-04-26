/**
 * Product filter — decides whether a Shopify order should be processed
 * based on the tenant's `allowedProductTypes` whitelist.
 *
 * Cache shape evolved over time. Both formats are supported here so that
 * existing tenants don't need to re-scan after a deploy.
 *
 * Legacy shape (string-only):
 *   { "<productId>": "Curvadivina" }
 *
 * Enriched shape (current):
 *   { "<productId>": { title?: string; type?: string; vendor?: string } }
 *
 * The whitelist is matched case-insensitively against ANY of {title, type,
 * vendor} (or the raw string for legacy entries). This means a tenant can
 * pin a single product (by title), a category (by type), or a brand (by
 * vendor) — and a previously saved filter like ["Aktiva"] keeps working
 * after the cache is upgraded.
 */
export type ProductCacheEntry =
  | string
  | { title?: string; type?: string; vendor?: string };

export type ProductCache = Record<string, ProductCacheEntry>;

interface OrderLineItem {
  product_id?: number | string | null;
}

interface OrderLike {
  line_items: OrderLineItem[];
}

/** Returns the candidate match-strings for one cache entry, lowercased. */
export function entryMatchTokens(entry: ProductCacheEntry | undefined): string[] {
  if (!entry) return [];
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed ? [trimmed.toLowerCase()] : [];
  }
  const tokens: string[] = [];
  if (entry.title && entry.title.trim()) tokens.push(entry.title.trim().toLowerCase());
  if (entry.type && entry.type.trim()) tokens.push(entry.type.trim().toLowerCase());
  if (entry.vendor && entry.vendor.trim()) tokens.push(entry.vendor.trim().toLowerCase());
  return tokens;
}

/**
 * True iff `order` has at least one line item whose cached product
 * descriptor matches any element of `allowedSet`.
 *
 * `allowedSet` MUST already be lowercased — caller normalizes once.
 *
 * Edge cases:
 *   - empty `allowedSet`            → true (no filter active, allow everything)
 *   - empty/missing `cache`         → false (filter active but cache absent;
 *                                     caller should warn and short-circuit
 *                                     to "process all")
 *   - line item without product_id  → ignored (cannot match)
 *   - product_id not in cache       → ignored (cannot match)
 */
export function orderMatchesAllowedProducts(
  order: OrderLike,
  allowedSet: Set<string>,
  cache: ProductCache,
): boolean {
  if (allowedSet.size === 0) return true;
  if (!cache || Object.keys(cache).length === 0) return false;

  for (const item of order.line_items ?? []) {
    if (item.product_id === undefined || item.product_id === null) continue;
    const entry = cache[String(item.product_id)];
    const tokens = entryMatchTokens(entry);
    for (const token of tokens) {
      if (allowedSet.has(token)) return true;
    }
  }
  return false;
}

/**
 * Build the lowercased `allowedSet` from the raw whitelist. Trims and skips
 * empty strings so we don't accidentally match every cache entry.
 */
export function buildAllowedSet(allowed: string[] | null | undefined): Set<string> {
  if (!allowed || allowed.length === 0) return new Set();
  return new Set(
    allowed
      .map((t) => (t ?? '').trim().toLowerCase())
      .filter((t) => t.length > 0),
  );
}
