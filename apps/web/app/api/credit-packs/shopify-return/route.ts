import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant } from '@/lib/api-utils';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import { fetchChargeStatus, isDeadStatus, isPaidStatus } from '@/lib/shopify-billing';
import { settlePaidPurchase } from '@/lib/credit-accrual';

/**
 * Vuelta del comerciante después de aprobar (o rechazar) el cargo de Shopify.
 *
 * POR QUÉ ACREDITA ACÁ Y NO SÓLO EN EL WEBHOOK. El webhook
 * `app_purchases_one_time/update` es la fuente autoritativa, pero puede
 * demorar: sin este camino el comerciante que acaba de pagar vuelve al panel
 * y ve el saldo viejo, que es el momento exacto en el que desconfía del
 * producto. Los dos llaman a `settlePaidPurchase`, que es idempotente por
 * partida doble (`updateMany` sobre PENDING + `mpPaymentId` único), así que
 * el que llegue segundo no acredita dos veces.
 *
 * NO SE CONFÍA EN LA VUELTA. El estado no se lee de la URL —cualquiera puede
 * escribirla— sino que se re-consulta el cargo a Shopify por su GID.
 */
export async function GET(req: NextRequest) {
  const destino = (q: string) =>
    NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/settings/billing?${q}`,
    );

  const auth = await getAuthenticatedTenant();
  if (!auth) return destino('error=sesion');

  const purchaseId = req.nextUrl.searchParams.get('purchase');
  if (!purchaseId) return destino('error=falta_compra');

  const purchase = await db.creditPurchase.findFirst({
    // El filtro por tenant es la autorización: nadie puede acreditar la compra de otro.
    where: { id: purchaseId, tenantId: auth.tenantId },
    select: { id: true, status: true, mpPreferenceId: true, shipments: true },
  });
  if (!purchase) return destino('error=compra_no_encontrada');
  if (purchase.status === 'PAID') return destino('success=true');
  if (!purchase.mpPreferenceId) return destino('error=cargo_sin_id');

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });
  const shop = tenant?.shopifyStoreUrl?.trim().toLowerCase();
  if (!tenant || !shop) return destino('error=tienda');

  const accessToken = await shopifyAccessForTenant(tenant);
  if (!accessToken) return destino('error=token');

  const status = await fetchChargeStatus(shop, accessToken, purchase.mpPreferenceId);

  if (isPaidStatus(status)) {
    const res = await settlePaidPurchase({
      purchaseId: purchase.id,
      externalPaymentId: `shopify:${purchase.mpPreferenceId}`,
      rail: 'shopify',
    });
    console.info(
      `[shopify-billing] retorno purchase=${purchase.id} status=${status} credited=${res.credited}`,
    );

    // 🔴 NO SE CANTA ÉXITO SIN HABER ACREDITADO. Acá el cargo ya está ACTIVE,
    // o sea que Shopify YA le cobró al comerciante. Si `settlePaidPurchase`
    // devolvió `credited:false`, los envíos no entraron y la pantalla verde
    // «Pago acreditado» sería mentira sobre plata cobrada — el peor cartel
    // posible, porque el comerciante se va tranquilo con saldo cero.
    //
    // `credited:false` acá tiene dos causas de distinto signo:
    //  - CARRERA BENIGNA: el webhook llegó primero y ya acreditó. La fila
    //    quedó en PAID, no hay nada roto, y el comerciante tiene que ver éxito.
    //  - PROBLEMA REAL: la fila estaba en FAILED (barrida) o el pago quedó
    //    pegado a otra compra. Ahí no se acreditó nada y hay que gritar.
    // Se distinguen releyendo el estado, que es la única autoridad.
    if (!res.credited) {
      const fresca = await db.creditPurchase.findUnique({
        where: { id: purchase.id },
        select: { status: true },
      });
      if (fresca?.status !== 'PAID') {
        console.error(
          `[shopify-billing] 🔴 COBRADO SIN ACREDITAR purchase=${purchase.id} ` +
            `charge=${purchase.mpPreferenceId} motivo=${res.reason} estado=${fresca?.status ?? 'sin_fila'}`,
        );
        return destino('error=pago_sin_acreditar');
      }
    }

    return destino('success=true');
  }

  if (isDeadStatus(status)) {
    await db.creditPurchase
      .updateMany({ where: { id: purchase.id, status: 'PENDING' }, data: { status: 'FAILED' } })
      .catch(() => {});
    return destino('error=rechazado');
  }

  // PENDING: el comerciante todavía no aprobó, o Shopify aún no lo movió.
  // No se marca nada: el webhook lo va a resolver.
  return destino('pending=true');
}
