/**
 * /api/v1/tenants
 *
 * GET  → list all stores (Tenants) the authenticated user owns. Used by
 *        the tenant switcher in the dashboard header to render the dropdown.
 *
 * POST → create a new empty Tenant for the authenticated user. The new
 *        Tenant starts with shipmentCredits=10 (welcome bonus default),
 *        no Shopify/DAC creds, no schedule. The client should then drive
 *        the user through /onboarding to fill those in. After creation,
 *        the response includes the new tenantId so the client can call
 *        /api/v1/tenants/switch to make it active.
 *
 * Privacy: response never includes encrypted secrets (shopifyToken,
 * dacPassword, etc.) — only the metadata needed for the switcher UI
 * and onboarding progress signaling.
 */

import { db } from '@/lib/db';
import crypto from 'crypto';
import {
  getAuthenticatedUser,
  apiError,
  apiSuccess,
} from '@/lib/api-utils';

export async function GET() {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  const tenants = await db.tenant.findMany({
    where: { userId: auth.userId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      slug: true,
      // Display-only fields — no secrets:
      shopifyStoreUrl: true,
      onboardingComplete: true,
      isActive: true,
      shipmentCredits: true,
      referralBonusCredits: true,
      // Help the UI show "Connected" vs "Setup pending" without leaking creds:
      // booleans only.
      createdAt: true,
    },
  });

  return apiSuccess({
    tenants: tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      shopifyStoreUrl: t.shopifyStoreUrl,
      onboardingComplete: t.onboardingComplete,
      isActive: t.isActive,
      // Total available credits = paid pool + bonus pool. Worker drains
      // bonus first; UI shows the combined number for simplicity.
      availableCredits: t.shipmentCredits + t.referralBonusCredits,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  let body: { name?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — we'll generate a default name.
  }

  // Sanitize and default the name. We allow user-provided to make the
  // switcher dropdown readable (e.g. "Karbon Uruguay" vs "Karbon Argentina")
  // but never expose this in OAuth flows or any public surface, so an
  // empty/whitespace name is harmless — we fall back to a generic label.
  const proposedName = (body.name ?? '').trim();
  const safeName = proposedName.length > 0 && proposedName.length <= 80
    ? proposedName
    : 'Mi tienda';

  // Build a unique slug. The slug is just for internal URLs / debugging
  // and has no SEO/marketing meaning, so a short random suffix is fine.
  const baseSlug =
    safeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30) ||
    'store';
  const slug = `${baseSlug}-${Date.now().toString(36).slice(-6)}`;

  // Welcome bonus is intentionally NOT given on additional stores — the
  // 10-credit bonus is per-USER per-lifetime, not per-store. Otherwise a
  // user could create unlimited stores to mine free credits. Set to 0
  // explicitly (overrides the schema default of 10).
  const tenant = await db.tenant.create({
    data: {
      userId: auth.userId,
      name: safeName,
      slug,
      apiKey: crypto.randomBytes(32).toString('hex'),
      tosAcceptedAt: new Date(),
      shipmentCredits: 0,
    },
    select: {
      id: true,
      name: true,
      slug: true,
    },
  });

  return apiSuccess({ tenant }, undefined);
}
