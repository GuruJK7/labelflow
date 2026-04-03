import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenantId = auth.tenantId;

  // Get the latest job (running or most recent)
  const activeJob = await db.job.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
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

  // Get recent labels (last 20) for shipment timeline
  const recentLabels = await db.label.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      shopifyOrderName: true,
      customerName: true,
      city: true,
      department: true,
      dacGuia: true,
      status: true,
      paymentType: true,
      totalUyu: true,
      emailSent: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Get real-time logs for active/recent job
  // Show logs if job is running OR finished within the last 5 minutes
  let activeLogs: unknown[] = [];
  const showLogs = activeJob && (
    activeJob.status === 'RUNNING' ||
    activeJob.status === 'PENDING' ||
    (activeJob.finishedAt && Date.now() - new Date(activeJob.finishedAt).getTime() < 5 * 60 * 1000)
  );
  if (activeJob && showLogs) {
    activeLogs = await db.runLog.findMany({
      where: { tenantId, jobId: activeJob.id },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        level: true,
        message: true,
        meta: true,
        createdAt: true,
      },
    });
  }

  // Summary stats
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [todayCount, weekCount] = await Promise.all([
    db.label.count({
      where: { tenantId, status: { in: ['CREATED', 'COMPLETED'] }, createdAt: { gte: todayStart } },
    }),
    db.label.count({
      where: {
        tenantId,
        status: { in: ['CREATED', 'COMPLETED'] },
        createdAt: { gte: new Date(Date.now() - 7 * 86400000) },
      },
    }),
  ]);

  return apiSuccess({
    activeJob,
    activeLogs,
    recentLabels,
    todayCount,
    weekCount,
  });
}
