import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const searchParams = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20')));
  const status = searchParams.get('status');
  const skip = (page - 1) * limit;

  const VALID_STATUSES = ['PENDING', 'CREATED', 'COMPLETED', 'FAILED', 'SKIPPED', 'all'];
  if (status && !VALID_STATUSES.includes(status.toUpperCase()) && status !== 'all') {
    return apiError('Invalid status value', 400);
  }

  const where: Record<string, unknown> = { tenantId: auth.tenantId };
  if (status && status !== 'all') {
    where.status = status.toUpperCase();
  }

  const [labels, total] = await Promise.all([
    db.label.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        shopifyOrderName: true,
        customerName: true,
        customerEmail: true,
        dacGuia: true,
        status: true,
        paymentType: true,
        totalUyu: true,
        city: true,
        department: true,
        emailSent: true,
        createdAt: true,
        pdfPath: true,
      },
    }),
    db.label.count({ where }),
  ]);

  return apiSuccess(labels, {
    total,
    page,
    limit,
    hasNext: skip + limit < total,
  });
}
