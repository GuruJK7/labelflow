import { NextRequest, NextResponse } from 'next/server';
import { getPreApprovalClient, PLANS, type PlanId } from '@/lib/mercadopago';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';

export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const planParam = req.nextUrl.searchParams.get('plan');
  if (!planParam || !(planParam in PLANS)) {
    return apiError('Plan invalido. Opciones: starter, growth, pro', 400);
  }

  const planId = planParam as PlanId;
  const plan = PLANS[planId];

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { id: true, name: true, userId: true },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  const user = await db.user.findUnique({
    where: { id: tenant.userId },
    select: { email: true, name: true },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    const preApproval = getPreApprovalClient();

    const result = await preApproval.create({
      body: {
        reason: `LabelFlow ${plan.name} - ${plan.labelLimit === 999999 ? 'Etiquetas ilimitadas' : `${plan.labelLimit} etiquetas/mes`}`,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: plan.priceUYU,
          currency_id: 'UYU',
        },
        back_url: `${appUrl}/settings/billing`,
        payer_email: user?.email ?? 'test@autoenvia.com',
        external_reference: `${auth.tenantId}|${plan.id}`,
      },
    });

    const checkoutUrl = result.init_point;

    if (!checkoutUrl) {
      console.error('[MERCADOPAGO] No init_point in preapproval response:', JSON.stringify(result));
      return apiError('Error al crear suscripcion', 500);
    }

    return NextResponse.redirect(checkoutUrl);
  } catch (err) {
    console.error('[MERCADOPAGO] Subscription checkout error:', (err as Error).message, (err as Error).stack);
    return apiError(`Error de MercadoPago: ${(err as Error).message}`, 500);
  }
}
