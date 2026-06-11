/**
 * GET /api/v1/control/recent-labels?limit=40&status=<LabelStatus|all>
 *
 * Most-recent executed orders (Label rows) ACROSS ALL of the user's stores,
 * newest first — powers the global "Ultimos envios" feed at the bottom of the
 * control dashboard. Cross-store: getAuthenticatedUser() + scope to the user's
 * own tenantIds (never a client-supplied tenantId).
 *
 * Each row includes the store name (tenant.name) so the feed shows which store
 * each shipment belongs to. pdfPath is reduced to a `hasPdf` boolean; the PDF
 * itself is signed on demand by /api/v1/control/labels/[id]/pdf (ownership-checked).
 */

import { NextRequest } from 'next/server';
import { LabelStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError, apiSuccess } from '@/lib/api-utils';
import { isResolvedExternally } from '@/lib/shopify-reconcile';

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
  const limit = Math.min(200, Math.max(1, parseInt(sp.get('limit') ?? '40', 10) || 40));
  const statusParam = (sp.get('status') ?? 'all').toUpperCase();

  const tenants = await db.tenant.findMany({
    where: { userId: auth.userId },
    select: { id: true },
  });
  if (tenants.length === 0) return apiSuccess([]);
  const tenantIds = tenants.map((t) => t.id);

  const where: { tenantId: { in: string[] }; status?: LabelStatus | { in: LabelStatus[] } } = {
    tenantId: { in: tenantIds },
  };
  if (statusParam === 'COMPLETED') {
    // "Completados" = dispatched-shipment set (a DAC guia was minted), matching
    // the CREATED|COMPLETED definition the cards/counters use, so a guia-minted-
    // but-PDF-pending (CREATED) label is not hidden from the filtered view.
    where.status = { in: [LabelStatus.CREATED, LabelStatus.COMPLETED] };
  } else if (statusParam !== 'ALL' && VALID_STATUSES.includes(statusParam as LabelStatus)) {
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
      createdAt: true,
      pdfPath: true,
      tenant: { select: { name: true } },
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
      // Hide the internal RESOLVED_MARKER sentinel; show a human-readable note.
      errorMessage: isResolvedExternally(l.errorMessage) ? 'Resuelto fuera del sistema (Shopify)' : l.errorMessage,
      createdAt: l.createdAt.toISOString(),
      hasPdf: !!l.pdfPath,
      store: l.tenant?.name ?? '—',
    })),
  );
}
