import { z } from 'zod';
import { db } from '@/lib/db';
import {
  getAuthenticatedTenant,
  apiError,
  apiSuccess,
} from '@/lib/api-utils';
import { encrypt } from '@/lib/encryption';

/**
 * POST /api/v1/onboarding/test-shopify
 *
 * Verifies the user-supplied Shopify URL + token by hitting the shop.json
 * Admin API endpoint. On success, persists both fields (token encrypted).
 *
 * Used by the onboarding wizard's Shopify step to give the user immediate,
 * trustable feedback ("Conexión OK ✓ — tu tienda 'XYZ'") before letting them
 * advance. Reusing the same logic as PUT /api/v1/settings (line 209-223 of
 * settings/route.ts) means a future schema change to either side has one
 * place to update — but we run it as a separate endpoint so the onboarding
 * UI can call it without triggering the full settings PUT side-effects
 * (DAC cookie invalidation, isActive cascades).
 */
const bodySchema = z.object({
  shopifyStoreUrl: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/,
      'Debe ser un dominio Shopify válido (ej: tu-tienda.myshopify.com)',
    ),
  shopifyToken: z.string().min(10).max(512),
});

export async function POST(request: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError('JSON inválido', 400);
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(
      parsed.error.errors[0]?.message ?? 'Datos inválidos',
      400,
    );
  }

  const { shopifyStoreUrl, shopifyToken } = parsed.data;

  // Verify against Shopify Admin API. shop.json is the canonical "is the
  // token valid + has read_products" probe — cheap, no side-effects.
  let shopName: string | null = null;
  try {
    const res = await fetch(
      `https://${shopifyStoreUrl}/admin/api/2024-01/shop.json`,
      {
        headers: { 'X-Shopify-Access-Token': shopifyToken },
        // Tight timeout: the user is staring at a spinner. If Shopify is
        // slow we'd rather fail fast than hold the wizard hostage.
        signal: AbortSignal.timeout(8000),
      },
    );

    if (res.status === 401 || res.status === 403) {
      return apiError(
        'Token rechazado por Shopify. Verificá los scopes (read_orders, write_orders, read_fulfillments, write_fulfillments) y volvé a generarlo.',
        422,
      );
    }
    if (!res.ok) {
      return apiError(
        `Shopify respondió ${res.status}. Verificá la URL y el token.`,
        422,
      );
    }

    const data = (await res.json()) as { shop?: { name?: string } };
    shopName = data.shop?.name ?? null;
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return apiError(
      isTimeout
        ? 'Shopify tardó demasiado en responder. Probá de nuevo.'
        : 'No se pudo conectar a Shopify. Verificá la URL.',
      422,
    );
  }

  // Persist (encrypt token at rest).
  await db.tenant.update({
    where: { id: auth.tenantId },
    data: {
      shopifyStoreUrl,
      shopifyToken: encrypt(shopifyToken),
    },
  });

  return apiSuccess({ ok: true, shopName });
}
