import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';
import { getPack } from '@/lib/credit-packs';
import { getWhopCheckoutUrls, WHOP_PENDING_REUSE_MINUTES } from '@/lib/whop';

/**
 * Inicia un checkout de pack por Whop (D34). Espejo de `checkout/route.ts`
 * (MercadoPago) pero sin API: Whop se paga por un link fijo por pack que
 * Adrian configura en `WHOP_CHECKOUT_URLS` (JSON `{packId: url}`).
 *
 *   1. Sesión + pack válido (precios siempre de la tabla, nunca del cliente).
 *   2. Sin URL para ese pack → 404: el botón ni siquiera se muestra en la UI.
 *   3. Si el mismo usuario ya tiene una PENDING de Whop del MISMO pack creada
 *      hace menos de WHOP_PENDING_REUSE_MINUTES, se reutiliza en vez de crear
 *      otra. Motivo (revisión 2026-09-02): el webhook resuelve el pago por el
 *      usuario y exige UNA sola PENDING reciente; dos clics en el botón
 *      dejaban dos, el pago llegaba como `flagged` y no acreditaba nada.
 *   4. Si no, se crea el CreditPurchase PENDING con `mpExternalRef = whop|<purchaseId>`
 *      (dos pasos, igual que MP, porque la columna es @unique) para que el
 *      webhook pueda encontrar la compra por id o, si el pago no trae
 *      metadata, por el usuario + la única PENDING de Whop reciente.
 *   5. 302 a la URL tal cual. No se le agregan parámetros: no está
 *      verificado que los links estáticos de Whop acepten metadata (PENDIENTES).
 */
export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const packParam = req.nextUrl.searchParams.get('pack');
  if (!packParam) return apiError('Falta parámetro pack', 400);

  const pack = getPack(packParam);
  if (!pack) {
    return apiError(
      'Pack inválido. Opciones: pack_10, pack_50, pack_100, pack_250, pack_500, pack_1000',
      400,
    );
  }

  const url = getWhopCheckoutUrls()[pack.id];
  if (!url) return apiError('Pago con Whop no disponible para este pack', 404);

  // Dos clics → una PENDING. Por usuario (todas sus tiendas comparten saldo,
  // y así resuelve el webhook), mismo pack, sólo compras de Whop y recientes.
  const since = new Date(Date.now() - WHOP_PENDING_REUSE_MINUTES * 60 * 1000);
  const reusable = await db.creditPurchase.findFirst({
    where: {
      tenant: { userId: auth.userId },
      packId: pack.id,
      status: 'PENDING',
      mpExternalRef: { startsWith: 'whop|' },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (reusable) {
    console.info(`[whop] checkout reutiliza purchase=${reusable.id} pack=${pack.id} tenant=${auth.tenantId}`);
    return NextResponse.redirect(url, 302);
  }

  const purchase = await db.creditPurchase.create({
    data: {
      tenantId: auth.tenantId,
      packId: pack.id,
      shipments: pack.shipments,
      pricePerShipmentUyu: pack.pricePerShipmentUyu,
      totalPriceUyu: pack.totalPriceUyu,
      status: 'PENDING',
      mpExternalRef: `whop|tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  await db.creditPurchase.update({
    where: { id: purchase.id },
    data: { mpExternalRef: `whop|${purchase.id}` },
  });

  console.info(`[whop] checkout iniciado purchase=${purchase.id} pack=${pack.id} tenant=${auth.tenantId}`);
  return NextResponse.redirect(url, 302);
}
