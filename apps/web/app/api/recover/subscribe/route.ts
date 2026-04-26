import { NextResponse } from 'next/server';
import { getPreApprovalClient } from '@/lib/mercadopago';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';

const RECOVER_PLAN_PRICE_UYU = 490; // $490 UYU/mes

// GET /api/recover/subscribe — Initiates MercadoPago PreApproval for Recover module
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const planId = process.env.RECOVER_MERCADOPAGO_PLAN_ID;
  if (!planId) {
    return apiError('Suscripcion no configurada en el servidor', 503);
  }

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { userId: true, name: true },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  const user = await db.user.findUnique({
    where: { id: tenant.userId },
    select: { email: true },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    const preApproval = getPreApprovalClient();

    const result = await preApproval.create({
      body: {
        preapproval_plan_id: planId,
        reason: 'AutoEnvia Recover — Recuperacion de carritos por WhatsApp',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: RECOVER_PLAN_PRICE_UYU,
          currency_id: 'UYU',
        },
        back_url: `${appUrl}/recover?subscribed=1`,
        payer_email: user?.email ?? 'test@autoenvia.com',
        external_reference: `${auth.tenantId}|recover`,
      },
    });

    const checkoutUrl = result.init_point;
    if (!checkoutUrl) {
      return apiError('Error al crear suscripcion con MercadoPago', 500);
    }

    return NextResponse.redirect(checkoutUrl);
  } catch (err) {
    console.error('[Recover Subscribe] MercadoPago error:', (err as Error).message);
    return apiError('Error al procesar la suscripción. Intenta de nuevo.', 500);
  }
}
