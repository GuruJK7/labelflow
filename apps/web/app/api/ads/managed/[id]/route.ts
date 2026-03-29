import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { decryptIfPresent } from '@/lib/encryption';

/**
 * PATCH /api/ads/managed/[id] — Pause or activate a managed ad.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAuthenticatedTenant();
  if (!session) return apiError('Unauthorized', 401);

  const { id } = await params;
  const body = await request.json();
  const { action } = body; // "pause" | "activate"

  if (!action || !['pause', 'activate'].includes(action)) {
    return apiError('Accion invalida. Usa "pause" o "activate".', 400);
  }

  // Verify ad belongs to this tenant
  const ad = await db.managedAd.findUnique({
    where: { id },
    include: { metaAdAccount: true },
  });

  if (!ad) return apiError('Anuncio no encontrado', 404);

  const adAccount = await db.metaAdAccount.findUnique({
    where: { tenantId: session.tenantId },
  });

  if (!adAccount || ad.metaAdAccountId !== adAccount.id) {
    return apiError('Anuncio no encontrado', 404);
  }

  if (!ad.metaAdId) {
    return apiError('Este anuncio no tiene ID de Meta asociado', 400);
  }

  const accessToken = decryptIfPresent(adAccount.metaAccessToken);
  if (!accessToken) {
    return apiError('Token de Meta no configurado', 400);
  }

  // Call Meta API
  const META_BASE = 'https://graph.facebook.com/v21.0';
  const newStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';

  const res = await fetch(`${META_BASE}/${ad.metaAdId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: accessToken,
      status: newStatus,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return apiError(`Error de Meta API: ${err}`, 502);
  }

  // Update local status
  const localStatus = action === 'pause' ? 'PAUSED' : 'ACTIVE';
  await db.managedAd.update({
    where: { id },
    data: { status: localStatus as 'PAUSED' | 'ACTIVE' },
  });

  return apiSuccess({ id, status: localStatus });
}
