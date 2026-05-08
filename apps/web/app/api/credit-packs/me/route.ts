import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { listPacks } from '@/lib/credit-packs';
import { getCreditHolderTenantId } from '@/lib/credit-holder';

/**
 * Devuelve el estado actual de créditos del tenant + historial reciente +
 * el catálogo de packs para que el cliente lo renderice sin hardcodear
 * precios en el frontend.
 */
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Audit 2026-05-08 — multi-store credit pool. Wallet (shipmentCredits,
  // creditsPurchased, creditsConsumed) lives on the user's CREDIT-HOLDER
  // tenant (oldest one), so we read from there. The PURCHASES history
  // is per-store though — when a user bought a pack, they were viewing
  // a specific tenant. We aggregate all of the user's tenants so the
  // billing screen shows the full purchase history regardless of which
  // store is active.
  const holderId = await getCreditHolderTenantId(auth.tenantId);
  const userTenantIds = await db.tenant.findMany({
    where: {
      user: { tenants: { some: { id: auth.tenantId } } },
    },
    select: { id: true },
  });
  const allUserTenantIds = userTenantIds.map((t) => t.id);

  const [holderWallet, recentPurchases] = await Promise.all([
    db.tenant.findUnique({
      where: { id: holderId },
      select: {
        shipmentCredits: true,
        creditsPurchased: true,
        creditsConsumed: true,
        referralCreditsEarned: true,
      },
    }),
    db.creditPurchase.findMany({
      where: { tenantId: { in: allUserTenantIds } },
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

  if (!holderWallet) return apiError('Tenant no encontrado', 404);

  return apiSuccess({
    balance: {
      shipmentCredits: holderWallet.shipmentCredits,
      creditsPurchased: holderWallet.creditsPurchased,
      creditsConsumed: holderWallet.creditsConsumed,
      referralCreditsEarned: holderWallet.referralCreditsEarned,
    },
    packs: listPacks(),
    recentPurchases,
  });
}
