import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

/**
 * GET /api/ads/jobs — List ad upload job history for the authenticated tenant.
 */
export async function GET() {
  const session = await getAuthenticatedTenant();
  if (!session) return apiError('Unauthorized', 401);

  const adAccount = await db.metaAdAccount.findUnique({
    where: { tenantId: session.tenantId },
  });

  if (!adAccount) {
    return apiSuccess({ jobs: [], total: 0 });
  }

  const jobs = await db.adUploadJob.findMany({
    where: { metaAdAccountId: adAccount.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return apiSuccess({
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      trigger: job.trigger,
      totalFiles: job.totalFiles,
      successCount: job.successCount,
      failedCount: job.failedCount,
      skippedCount: job.skippedCount,
      durationMs: job.durationMs,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      createdAt: job.createdAt,
    })),
    total: jobs.length,
  });
}
