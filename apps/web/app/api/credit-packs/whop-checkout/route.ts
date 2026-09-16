import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';
import { getPack, packIdList } from '@/lib/credit-packs';
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
 *
 * D35: el precio del pack está en dólares y Whop cobra en dólares, así que acá
 * no hay conversión. Los pesos que se guardan en la fila son sólo para que el
 * historial y los reportes hablen una sola moneda; el importe real que cobra
 * Whop lo fija el plan que Adrian creó allá (por eso `WHOP_PLAN_IDS` con
 * `minUsd` es la defensa: ver PENDIENTES para los dos planes nuevos).
 */
export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const packParam = req.nextUrl.searchParams.get('pack');
  if (!packParam) return apiError('Falta parámetro pack', 400);

  const pack = getPack(packParam);
  if (!pack) {
    return apiError(`Pack inválido. Opciones: ${packIdList()}`, 400);
  }

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });
  if (!tenant) return apiError('Tenant no encontrado', 404);

  /**
   * 🔴 REQUISITO 1.2.1 DEL APP STORE — el corte no puede ser sólo de UI.
   *
   * «Apps that use off-platform billing cannot be distributed through the
   * Shopify App Store». La pantalla ya no muestra el botón de Whop cuando la
   * tienda entró por Shopify (`shopifyBilling` en /api/credit-packs/me), pero
   * el endpoint seguía abierto: con la URL a mano redirigía igual al checkout
   * de Whop. Eso ES cobro fuera de la plataforma.
   *
   * MISMA REGLA, UN SOLO LUGAR DE VERDAD: `shopifyStoreUrl && shopifyToken`
   * sobre el tenant que ORIGINA la compra (no el holder del saldo), idéntica a
   * `app/api/credit-packs/me/route.ts`. Si divergen, pantalla y server dicen
   * cosas distintas y es peor que no tener el corte.
   *
   * VA ANTES QUE EL LOOKUP DEL LINK a propósito: fail-closed. Si el corte
   * quedara después, un pack sin URL configurada contestaría 404 «no
   * disponible» y el día que alguien configure ese link el endpoint se
   * reabriría solo para un tenant de Shopify.
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
