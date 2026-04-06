import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import type { RecoverStats } from '@/types/recover';

// GET /api/recover/stats?period=7d|30d|all
export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { searchParams } = new URL(req.url);
  const period = searchParams.get('period') ?? '30d';

  let afterDate: Date | null = null;
  if (period === '7d') {
    afterDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === '30d') {
    afterDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }

  const dateFilter = afterDate ? { createdAt: { gte: afterDate } } : {};
  const baseWhere = { tenantId: auth.tenantId, ...dateFilter };

  // Use DB-level aggregation instead of loading all rows into memory
  const [statusCounts, revenueAgg] = await Promise.all([
    db.recoverCart.groupBy({
      by: ['status'],
      where: baseWhere,
      _count: { status: true },
    }),
    db.recoverCart.aggregate({
      where: { ...baseWhere, status: 'RECOVERED' },
      _sum: { cartTotal: true },
    }),
  ]);

  const countByStatus = (statuses: string[]) =>
    statusCounts
      .filter((g) => statuses.includes(g.status))
      .reduce((sum, g) => sum + g._count.status, 0);

  const totalDetected = statusCounts.reduce((sum, g) => sum + g._count.status, 0);
  const totalSent = countByStatus(['MESSAGE_1_SENT', 'MESSAGE_2_SENT', 'RECOVERED']);
  const totalRecovered = countByStatus(['RECOVERED']);
  const totalOptedOut = countByStatus(['OPTED_OUT']);
  const revenueRecovered = revenueAgg._sum.cartTotal ?? 0;
  const recoveryRate = totalSent > 0 ? (totalRecovered / totalSent) * 100 : 0;

  const stats: RecoverStats = {
    totalDetected,
    totalSent,
    totalRecovered,
    totalOptedOut,
    recoveryRate: Math.round(recoveryRate * 10) / 10,
    revenueRecovered: Math.round(revenueRecovered),
  };

  return apiSuccess(stats);
}
