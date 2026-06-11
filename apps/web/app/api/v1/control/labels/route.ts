/**
 * GET /api/v1/control/labels?tenantId=<id>&limit=60&status=<LabelStatus|all>
 *
 * Recent executed orders (Label rows) for ONE owned store — powers the
 * "Pedidos ejecutados" modal on the multi-store control dashboard. Cross-store,
 * so it uses getAuthenticatedUser() + an explicit ownership check on the
 * tenantId (the active-tenant /api/v1/orders endpoint can't see other stores).
 *
 * Privacy: returns only the order/label fields the modal renders; pdfPath is
 * reduced to a `hasPdf` boolean (the actual PDF is signed on demand by
 * /api/v1/control/labels/[id]/pdf).
 */

import { NextRequest } from 'next/server';
import { LabelStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError, apiSuccess } from '@/lib/api-utils';

const VALID_STATUSES: LabelStatus[] = [
  LabelStatus.PENDING,
  LabelStatus.CREATED,
  LabelStatus.COMPLETED,
  LabelStatus.FAILED,
  LabelStatus.SKIPPED,
  LabelStatus.NEEDS_REVIEW,
];

export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  const sp = req.nextUrl.searchParams;
  const tenantId = sp.get('tenantId') ?? '';
  if (!tenantId) return apiError('Falta tenantId', 422);

  const limit = Math.min(100, Math.max(1, parseInt(sp.get('limit') ?? '60', 10) || 60));
  const statusParam = (sp.get('status') ?? 'all').toUpperCase();

  // Ownership — same 403 whether someone else's or nonexistent.
  const owned = await db.tenant.findFirst({
    where: { id: tenantId, userId: auth.userId },
    select: { id: true },
  });
  if (!owned) return apiError('Tienda no encontrada', 403);

  const where: { tenantId: string; status?: LabelStatus } = { tenantId };
  if (statusParam !== 'ALL' && VALID_STATUSES.includes(statusParam as LabelStatus)) {
    where.status = statusParam as LabelStatus;
  }

  const labels = await db.label.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      shopifyOrderName: true,
      customerName: true,
      city: true,
      status: true,
      dacGuia: true,
      errorMessage: true,
      paymentType: true,
      createdAt: true,
      pdfPath: true,
    },
  });

  return apiSuccess(
    labels.map((l) => ({
      id: l.id,
      orderName: l.shopifyOrderName,
      customer: l.customerName,
      city: l.city,
      status: l.status,
      dacGuia: l.dacGuia,
      errorMessage: l.errorMessage,
      paymentType: l.paymentType,
      createdAt: l.createdAt.toISOString(),
      hasPdf: !!l.pdfPath,
    })),
  );
}
