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
 * Constant-time token check. Returns false when the portal is unconfigured so
 * a missing secret never accidentally allows access. Both sides are hashed
 * first, which sidesteps the equal-length requirement of timingSafeEqual and
 * avoids leaking the secret's length through timing.
 */
export function isValidClientToken(candidate: string | undefined | null): boolean {
  const expected = getConfiguredToken();
  if (!expected) return false;
  if (!candidate || typeof candidate !== 'string') return false;
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
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
export async function loadClientView(): Promise<{
  stores: ClientViewStore[];
  labels: ClientViewLabel[];
}> {
  const tenantIds = getClientViewTenantIds();
  if (tenantIds.length === 0) return { stores: [], labels: [] };

  const [tenants, rows] = await Promise.all([
    db.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true, shopifyStoreUrl: true },
    }),
    db.label.findMany({
      where: { tenantId: { in: tenantIds }, pdfPath: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 2000,
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
): Promise<string | null> {
  const tenantIds = getClientViewTenantIds();
  if (tenantIds.length === 0) return null;
  const label = await db.label.findFirst({
    where: { id: labelId, tenantId: { in: tenantIds } },
    select: { pdfPath: true },
  });
  return label?.pdfPath ?? null;
}
