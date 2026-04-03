import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import type { CartStatus } from '@/types/recover';

const VALID_STATUSES: CartStatus[] = [
  'PENDING', 'MESSAGE_1_SENT', 'MESSAGE_2_SENT',
  'RECOVERED', 'OPTED_OUT', 'NO_PHONE', 'FAILED',
];

// GET /api/recover/carts?page=1&limit=20&status=PENDING
export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)));
  const statusParam = searchParams.get('status') as CartStatus | null;

  const statusFilter =
    statusParam && VALID_STATUSES.includes(statusParam) ? statusParam : undefined;

  const [carts, total] = await Promise.all([
    db.recoverCart.findMany({
      where: {
        tenantId: auth.tenantId,
        ...(statusFilter ? { status: statusFilter } : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.recoverCart.count({
      where: {
        tenantId: auth.tenantId,
        ...(statusFilter ? { status: statusFilter } : {}),
      },
    }),
  ]);

  return apiSuccess(carts, { total, page, limit, pages: Math.ceil(total / limit) });
}
