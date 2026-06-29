/**
 * Client portal — a shareable, login-less, read-only label view.
 *
 * A single unguessable token lets ONE client see ONLY the labels of a fixed
 * allow-list of stores (tenants), grouped by day. There is no account and no
 * session: access is gated entirely by the token, compared in constant time.
 *
 * Config (env, set on Render — never hardcoded, the token is a secret):
 *   CLIENT_VIEW_TOKEN        long URL-safe secret; the `[token]` in the URL
 *   CLIENT_VIEW_TENANT_IDS   comma-separated tenant ids the link may expose
 *
 * Privacy posture: the on-screen list is PII-minimized — it shows order #,
 * store, city, tracking guia, status and day, but NOT recipient name, phone,
 * email, address or amounts. Full recipient details live only inside the label
 * PDF, which the client legitimately needs to print and ship. If the token env
 * is unset the portal is effectively disabled: every candidate token fails
 * validation, so a forgotten secret can never accidentally allow access.
 *
 * Scoping is enforced in every query via `tenantId in CLIENT_VIEW_TENANT_IDS`,
 * so the link can never widen to a store outside the allow-list.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';

export interface ClientViewStore {
  id: string;
  name: string;
  url: string | null;
}

export interface ClientViewLabel {
  id: string;
  storeId: string;
  orderName: string | null;
  dacGuia: string | null;
  city: string | null;
  department: string | null;
  status: string;
  createdAt: string; // ISO 8601
  hasPdf: boolean;
}

function getConfiguredToken(): string | null {
  const t = process.env.CLIENT_VIEW_TOKEN?.trim();
  return t && t.length > 0 ? t : null;
}

export function getClientViewTenantIds(): string[] {
  return (process.env.CLIENT_VIEW_TENANT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isClientViewConfigured(): boolean {
  return getConfiguredToken() !== null && getClientViewTenantIds().length > 0;
}

/**
 * Rolling window (in days) of labels the portal renders. We deliberately do NOT
 * load "the most recent N labels": two busy stores can create >2000 labels in
 * under a month, so a fixed `take` silently drops the OLDEST days — which made
 * the on-screen total stick at the cap and the day count come up short, and hid
 * those days' labels from printing. A date window instead shows EVERY label in
 * the window, so the totals and day count are always complete, while the read
 * stays bounded: it rides the @@index([tenantId, createdAt desc]) and the
 * `take` in loadClientView is only a safety backstop. Override on Render with
 * CLIENT_VIEW_WINDOW_DAYS (default 90) to widen/narrow the history shown.
 */
export function getClientViewWindowDays(): number {
  const n = Number(process.env.CLIENT_VIEW_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90;
}

/**
 * Constant-time token check for the LEGACY single-token (env) portal. Returns
 * false when unconfigured so a missing secret never accidentally allows access.
 * Both sides are hashed first, which sidesteps the equal-length requirement of
 * timingSafeEqual and avoids leaking the secret's length through timing.
 */
export function isValidClientToken(candidate: string | undefined | null): boolean {
  const expected = getConfiguredToken();
  if (!expected) return false;
  if (!candidate || typeof candidate !== 'string') return false;
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Resolve a portal token to the EXACT set of stores it may expose, or null when
 * the token matches nothing (the caller then renders the normal 404/401, so
 * existence never leaks).
 *
 * Two sources, checked in order:
 *   1. The legacy single token (env CLIENT_VIEW_TOKEN -> CLIENT_VIEW_TENANT_IDS),
 *      compared in constant time. This keeps the existing shared link working
 *      with zero config change.
 *   2. Per-link tokens stored in the `client_portal_tokens` table — a
 *      `(token_hash, tenant_ids)` row, looked up by the sha256 hash of the
 *      candidate (the plaintext token is never stored, so a DB read can't reveal
 *      a usable token). This is how additional, store-scoped links are added
 *      WITHOUT touching env vars: insert one row and the link works.
 *
 * Any failure of the DB lookup (table missing, transient error) is treated as
 * "no match" -> the portal stays fail-closed.
 */
export async function resolveClientToken(
  candidate: string | undefined | null,
): Promise<string[] | null> {
  if (!candidate || typeof candidate !== 'string') return null;

  // 1) Legacy env token (constant-time).
  const expected = getConfiguredToken();
  if (expected) {
    const a = createHash('sha256').update(candidate).digest();
    const b = createHash('sha256').update(expected).digest();
    if (timingSafeEqual(a, b)) {
      const ids = getClientViewTenantIds();
      if (ids.length > 0) return ids;
    }
  }

  // 2) Per-link token rows (lookup by sha256 hash — never store the plaintext).
  try {
    const hash = createHash('sha256').update(candidate).digest('hex');
    const rows = await db.$queryRaw<Array<{ tenant_ids: string }>>`
      SELECT tenant_ids FROM client_portal_tokens WHERE token_hash = ${hash} LIMIT 1
    `;
    const raw = rows[0]?.tenant_ids;
    if (raw) {
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) return ids;
    }
  } catch {
    // Table not present yet / transient DB error -> fail closed (no access).
  }

  return null;
}

/** "vi0zry-r1.myshopify.com" -> "vi0zry-r1" (fallback label when unnamed). */
function storeLabelFromUrl(url: string | null): string {
  if (!url) return 'Tienda';
  return url.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/i, '') || 'Tienda';
}

/**
 * Loads the allow-listed stores plus their created (downloadable) labels.
 * Strictly scoped to CLIENT_VIEW_TENANT_IDS. Store names fall back to the
 * myshopify subdomain when a store is still the default "Nueva tienda" or
 * has no name, so the two stores are always distinguishable in the selector.
 */
export async function loadClientView(tenantIds: string[]): Promise<{
  stores: ClientViewStore[];
  labels: ClientViewLabel[];
}> {
  if (tenantIds.length === 0) return { stores: [], labels: [] };

  // Rolling window: show every (downloadable) label created in the last N days,
  // not a fixed "most recent 2000" — see getClientViewWindowDays() for why.
  const since = new Date(
    Date.now() - getClientViewWindowDays() * 24 * 60 * 60 * 1000,
  );

  const [tenants, rows] = await Promise.all([
    db.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true, shopifyStoreUrl: true },
    }),
    db.label.findMany({
      where: {
        tenantId: { in: tenantIds },
        pdfPath: { not: null },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      // Safety backstop only; the date window above is the real bound.
      take: 50000,
      select: {
        id: true,
        tenantId: true,
        shopifyOrderName: true,
        dacGuia: true,
        city: true,
        department: true,
        status: true,
        createdAt: true,
        pdfPath: true,
      },
    }),
  ]);

  const stores: ClientViewStore[] = tenants.map((t) => {
    const trimmed = (t.name ?? '').trim();
    const isDefault =
      trimmed.length === 0 || trimmed.toLowerCase() === 'nueva tienda';
    return {
      id: t.id,
      name: isDefault ? storeLabelFromUrl(t.shopifyStoreUrl) : trimmed,
      url: t.shopifyStoreUrl ?? null,
    };
  });

  const labels: ClientViewLabel[] = rows.map((r) => ({
    id: r.id,
    storeId: r.tenantId,
    orderName: r.shopifyOrderName,
    dacGuia: r.dacGuia,
    city: r.city,
    department: r.department,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    hasPdf: !!r.pdfPath,
  }));

  return { stores, labels };
}

/**
 * Used by the PDF endpoint: confirms a label id belongs to an allow-listed
 * store and returns its storage path, or null otherwise. Callers 404 on null
 * so the response never reveals whether the id exists for some other tenant.
 */
export async function getClientViewLabelPdfPath(
  labelId: string,
  tenantIds: string[],
): Promise<string | null> {
  if (tenantIds.length === 0) return null;
  const label = await db.label.findFirst({
    where: { id: labelId, tenantId: { in: tenantIds } },
    select: { pdfPath: true },
  });
  return label?.pdfPath ?? null;
}

/**
 * Batch variant for bulk printing. Given a list of label ids, returns only the
 * ones that both belong to an allow-listed store AND have a stored PDF, as
 * { id, pdfPath } pairs. Ids outside the allow-list, without a PDF, duplicated,
 * or simply non-existent are silently dropped — the bulk endpoint never reveals
 * which ids it rejected. Output preserves the input order so the merged PDF
 * comes out in the same order the client selected on screen.
 */
export async function getClientViewLabelPdfPaths(
  ids: string[],
  tenantIds: string[],
): Promise<{ id: string; pdfPath: string }[]> {
  if (tenantIds.length === 0 || ids.length === 0) return [];

  const rows = await db.label.findMany({
    where: {
      id: { in: ids },
      tenantId: { in: tenantIds },
      pdfPath: { not: null },
    },
    select: { id: true, pdfPath: true },
  });

  const byId = new Map(rows.map((r) => [r.id, r.pdfPath as string]));
  const seen = new Set<string>();
  const ordered: { id: string; pdfPath: string }[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const pdfPath = byId.get(id);
    if (pdfPath) {
      seen.add(id);
      ordered.push({ id, pdfPath });
    }
  }
  return ordered;
}
