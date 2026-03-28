import { NextResponse } from 'next/server';
import { getPreApprovalClient } from '@/lib/mercadopago';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';

export async function POST() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: {
      id: true,
      stripeSubscriptionId: true,
      subscriptionStatus: true,
    },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  const subscriptionId = tenant.stripeSubscriptionId;

  if (!subscriptionId || !subscriptionId.startsWith('mp_sub_')) {
    return apiError('No hay suscripcion activa de MercadoPago', 400);
  }

  // Extract the preapproval ID from the stored subscription ID
  const preapprovalId = subscriptionId.replace('mp_sub_', '');

  try {
    const preApproval = getPreApprovalClient();

    await preApproval.update({
      id: preapprovalId,
      body: {
        status: 'cancelled',
      },
    });

    await db.tenant.update({
      where: { id: auth.tenantId },
      data: {
        subscriptionStatus: 'CANCELED',
        isActive: false,
        stripeSubscriptionId: null,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Suscripcion cancelada exitosamente',
    });
  } catch (err) {
    console.error('[MERCADOPAGO] Cancel subscription error:', (err as Error).message);
    return apiError(`Error al cancelar suscripcion: ${(err as Error).message}`, 500);
  }
}
