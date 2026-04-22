import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

/**
 * POST /api/v1/labels/[id]/redo
 *
 * Operator-initiated "reenviar" action. Deletes the Label row + matching
 * PendingShipment row atomically, which unblocks the worker's two skip
 * guards:
 *
 *  - `process-orders.job.ts` picker skips Shopify-unfulfilled orders that
 *    already have a COMPLETED Label in the DB (prevents the duplication
 *    loop when Shopify's fulfillment POST is failing silently).
 *  - `assertNoPriorSubmit` in shipment.ts throws DuplicateSubmitError when
 *    a recent (<72h) RESOLVED PendingShipment exists for the order.
 *
 * Deleting both rows means: next cron tick, the order flows through
 * naturally (Shopify still reports it as unfulfilled, DB has nothing to
 * skip/block), and a fresh DAC guía is minted cleanly.
 *
 * Audit trail:
 *  - A RunLog row is written recording the label ID, the previous guía,
 *    and the operator's tenantId.
 *  - The Shopify order note still carries "LabelFlow-GUIA: ..." entries
 *    from prior shipments (appended, never overwritten).
 *
 * Safety:
 *  - Tenant-scoped: only labels owned by the authenticated tenant are
 *    eligible.
 *  - Idempotent on the PendingShipment delete: Prisma P2025 (row not
 *    found) is swallowed so a partial prior redo or external cleanup
 *    doesn't break the flow.
 *  - Wrapped in $transaction so both deletes succeed together or neither
 *    applies.
 */
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const { id } = await context.params;
  const tenantId = auth.tenantId;

  const label = await db.label.findFirst({
    where: { id, tenantId },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      dacGuia: true,
      status: true,
    },
  });

  if (!label) return apiError('Etiqueta no encontrada', 404);

  const result = await db.$transaction(async (tx) => {
    await tx.label.delete({ where: { id: label.id } });

    let deletedPending = false;
    try {
      await tx.pendingShipment.delete({
        where: {
          tenantId_shopifyOrderId: {
            tenantId,
            shopifyOrderId: label.shopifyOrderId,
          },
        },
      });
      deletedPending = true;
    } catch (err) {
      // P2025 = row not found. Safe to ignore — operator may have already
      // run a reconcile, or the prior attempt never reached the marker.
      const code = (err as { code?: string }).code;
      if (code !== 'P2025') throw err;
    }

    await tx.runLog.create({
      data: {
        tenantId,
        jobId: null,
        level: 'INFO',
        message: 'label-redo',
        meta: {
          labelId: label.id,
          shopifyOrderId: label.shopifyOrderId,
          shopifyOrderName: label.shopifyOrderName,
          previousGuia: label.dacGuia,
          previousStatus: label.status,
          deletedPendingShipment: deletedPending,
          triggeredBy: 'dashboard-redo',
        },
      },
    });

    return { deletedPending };
  });

  return apiSuccess({
    orderName: label.shopifyOrderName,
    previousGuia: label.dacGuia,
    deletedPendingShipment: result.deletedPending,
    message:
      'Etiqueta y PendingShipment borrados. En la próxima corrida del worker la orden se reenvía automáticamente (debe seguir "unfulfilled" en Shopify).',
  });
}
