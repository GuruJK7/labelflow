import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');
  const since = searchParams.get('since');
  const limit = parseInt(searchParams.get('limit') ?? '200');

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (jobId) where.jobId = jobId;
  if (since) {
    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      return apiError('Invalid since parameter — must be a valid ISO date', 400);
    }
    where.createdAt = { gt: sinceDate };
  }

  const logs = await db.runLog.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: Math.min(limit, 500),
    select: {
      id: true,
      level: true,
      message: true,
      meta: true,
      createdAt: true,
      jobId: true,
    },
  });

  // Also return the active/latest job
  const activeJob = await db.job.findFirst({
    where: { tenantId: auth.tenantId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      trigger: true,
      totalOrders: true,
      successCount: true,
      failedCount: true,
      skippedCount: true,
      durationMs: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });

  return apiSuccess({ logs, activeJob });
}
