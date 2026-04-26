import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { listPacks } from '@/lib/credit-packs';

/**
 * Devuelve el estado actual de créditos del tenant + historial reciente +
 * el catálogo de packs para que el cliente lo renderice sin hardcodear
 * precios en el frontend.
 */
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const [tenant, recentPurchases] = await Promise.all([
    db.tenant.findUnique({
      where: { id: auth.tenantId },
      select: {
        shipmentCredits: true,
        creditsPurchased: true,
        creditsConsumed: true,
        referralCreditsEarned: true,
      },
    }),
    db.creditPurchase.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        packId: true,
        shipments: true,
        totalPriceUyu: true,
        status: true,
        paidAt: true,
        createdAt: true,
      },
    }),
  ]);

  if (!tenant) return apiError('Tenant no encontrado', 404);

  return apiSuccess({
    balance: {
      shipmentCredits: tenant.shipmentCredits,
      creditsPurchased: tenant.creditsPurchased,
      creditsConsumed: tenant.creditsConsumed,
      referralCreditsEarned: tenant.referralCreditsEarned,
    },
    packs: listPacks(),
    recentPurchases,
  });
}
