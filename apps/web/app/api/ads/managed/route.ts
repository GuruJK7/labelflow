import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

/**
 * GET /api/ads/managed — List managed ads for the authenticated tenant.
 */
export async function GET() {
  const session = await getAuthenticatedTenant();
  if (!session) return apiError('Unauthorized', 401);

  const adAccount = await db.metaAdAccount.findUnique({
    where: { tenantId: session.tenantId },
  });

  if (!adAccount) {
    return apiSuccess({ ads: [], total: 0 });
  }

  const ads = await db.managedAd.findMany({
    where: { metaAdAccountId: adAccount.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return apiSuccess({
    ads: ads.map((ad) => ({
      id: ad.id,
      creativeName: ad.creativeName,
      creativeType: ad.creativeType,
      status: ad.status,
      metaAdId: ad.metaAdId,
      headline: ad.headline,
      bodyText: ad.bodyText,
      callToAction: ad.callToAction,
      linkUrl: ad.linkUrl,
      impressions: ad.impressions,
      clicks: ad.clicks,
      spend: ad.spend,
      purchases: ad.purchases,
      ctr: ad.ctr,
      cpc: ad.cpc,
      cpm: ad.cpm,
      roas: ad.roas,
      purchaseIntentRate: ad.purchaseIntentRate,
      lastCheckedAt: ad.lastCheckedAt,
      errorMessage: ad.errorMessage,
      createdAt: ad.createdAt,
    })),
    total: ads.length,
  });
}
