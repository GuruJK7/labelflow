import { NextResponse } from 'next/server';
import { getPreApprovalClient } from '@/lib/mercadopago';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';

const RECOVER_PLAN_PRICE_UYU = 490; // $490 UYU/mes

// GET /api/recover/subscribe — Initiates MercadoPago PreApproval for Recover module
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { userId: true, name: true, shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  /**
   * 🔴 REQUISITO 1.2.1 DEL APP STORE — EL CUARTO RIEL.
   *
   * «Apps that use off-platform billing cannot be distributed through the
   * Shopify App Store». Los otros tres rieles (packs por MercadoPago, packs
   * por Whop, suscripción mensual) ya están cerrados; éste quedó abierto y es
   * del tipo caro: una PreApproval es una SUSCRIPCIÓN, $490 UYU/mes
   * RECURRENTES que siguen corriendo hasta que alguien los cancele a mano.
   * Acá ni siquiera hay un botón que esconder: alcanza con que un comerciante
   * de Shopify logueado —o un revisor tecleando— pegue la URL.
   *
   * MISMA REGLA, UN SOLO LUGAR DE VERDAD: `shopifyStoreUrl && shopifyToken`
   * sobre el tenant que ORIGINA la compra, idéntica a
   * `app/api/credit-packs/me/route.ts` y a los otros tres rieles. Si una
   * diverge, la pantalla y el server dicen cosas distintas.
   *
   * VA ANTES QUE EL CHEQUEO DE `RECOVER_MERCADOPAGO_PLAN_ID` a propósito:
   * fail-closed. Si el corte quedara después, hoy —sin la env configurada—
   * el endpoint contestaría 503 «no configurada» y el día que alguien cargue
   * el plan se reabriría solo para un tenant de Shopify.
   *
   * Los tenants que NO vienen de Shopify (carga propia, DEPO) siguen pasando
   * por acá sin cambios.
   */
  if (tenant.shopifyStoreUrl && tenant.shopifyToken) {
    return NextResponse.json(
      {
        error: 'Esta tienda paga por Shopify: los envíos se compran desde la factura de tu tienda.',
        code: 'SHOPIFY_BILLING_ONLY',
        checkoutUrl: '/api/credit-packs/shopify-checkout',
      },
      { status: 409 },
    );
  }

  const planId = process.env.RECOVER_MERCADOPAGO_PLAN_ID;
  if (!planId) {
    return apiError('Suscripcion no configurada en el servidor', 503);
  }

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
