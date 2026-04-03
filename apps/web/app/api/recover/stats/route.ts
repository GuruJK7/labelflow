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

  const carts = await db.recoverCart.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(afterDate ? { createdAt: { gte: afterDate } } : {}),
    },
    select: { status: true, cartTotal: true },
  });

  const totalDetected = carts.length;
  const totalSent = carts.filter((c) =>
    ['MESSAGE_1_SENT', 'MESSAGE_2_SENT', 'RECOVERED'].includes(c.status)
  ).length;
  const totalRecovered = carts.filter((c) => c.status === 'RECOVERED').length;
  const totalOptedOut = carts.filter((c) => c.status === 'OPTED_OUT').length;
  const revenueRecovered = carts
    .filter((c) => c.status === 'RECOVERED')
    .reduce((sum, c) => sum + (c.cartTotal ?? 0), 0);
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
