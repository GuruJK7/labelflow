import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant } from '@/lib/api-utils';
import { getPack, packIdList } from '@/lib/credit-packs';
import { getUsdUyuRateMilli, usdMilliToUyuWhole } from '@/lib/pricing';
import { shopifyAccessForTenant } from '@/lib/shopify-access';
import {
  createOneTimeCharge,
  isDevelopmentStore,
  ShopifyBillingError,
  ShopifyPlanUnresolvedError,
} from '@/lib/shopify-billing';
import { registerShopifyWebhooks } from '@/lib/shopify-register-webhooks';

/**
 * Compra de un pack cobrada POR SHOPIFY (requisito 1.2 del App Store).
 *
 * Es el gemelo de `credit-packs/checkout` (MercadoPago) para el comerciante
 * que conectó su tienda por Shopify. Mismo pack, misma escalera, mismo
 * precio; cambia quién cobra. Ver `lib/shopify-billing.ts` para el porqué.
 *
 * FLUJO
 *   1. Sesión + pack válido (defensa contra precios inyectados: el monto NO
 *      viene del cliente, sale del catálogo).
 *   2. La tienda tiene que estar conectada por Shopify y con token válido.
 *      Si no, 409 y el comerciante sigue por MercadoPago.
 *   3. `CreditPurchase` en PENDING ANTES de hablar con Shopify: si Shopify
 *      falla, la fila queda PENDING y nunca pasa a PAID — no es deuda.
 *   4. `appPurchaseOneTimeCreate` → se guarda el GID del cargo en
 *      `mpPreferenceId` y se redirige al `confirmationUrl`.
 *
 * DOS CAMINOS PARA ACREDITAR, los dos idempotentes por `settlePaidPurchase`:
 * el webhook `app_purchases_one_time/update` y el retorno del comerciante
 * (`/api/credit-packs/shopify-return`). Con uno solo, un webhook demorado
 * dejaría al comerciante mirando un saldo viejo después de pagar.
 *
 * 🔴 EL PRECIO EN PESOS QUE SE GUARDA ES INFORMATIVO. Las columnas
 * `pricePerShipmentUyu` / `totalPriceUyu` son NOT NULL y las lee el panel;
 * en este riel no se cobra un peso. Se guarda la conversión al tipo vigente
 * para que los reportes no mientan sobre la magnitud, pero lo cobrado es el
 * total en USD del catálogo.
 */
export async function GET(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  // 🔴 ESTE ENDPOINT ES EL DESTINO DE UNA NAVEGACIÓN, NO DE UN FETCH. El botón
  // «Pagar con Shopify» hace `window.location.href = …` (la pestaña entera va
  // acá y de acá a Shopify). Todo error tiene que volver al panel con un
  // motivo que la pantalla sepa pintar: contestar JSON era mostrarle al
  // comerciante —y al revisor del App Store— un `{"error":…}` crudo en la
  // pestaña, sin botón de volver. Los motivos viven en MENSAJE_ERROR de
  // settings/billing/page.tsx.
  const destino = (motivo: string) => NextResponse.redirect(`${appUrl}/settings/billing?error=${motivo}`);

  const auth = await getAuthenticatedTenant();
  if (!auth) return NextResponse.redirect(`${appUrl}/login`);

  const packParam = req.nextUrl.searchParams.get('pack');
  if (!packParam) return destino('pack');

  const rateMilli = getUsdUyuRateMilli();
  const pack = getPack(packParam, rateMilli);
  if (!pack) {
    console.warn(`[shopify-billing] pack inválido «${packParam}»; opciones: ${packIdList()}`);
    return destino('pack');
  }

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { id: true, shopifyStoreUrl: true, shopifyToken: true },
  });
  if (!tenant) return destino('tienda');

  const shop = tenant.shopifyStoreUrl?.trim().toLowerCase();
  if (!shop) return destino('tienda');

  const accessToken = await shopifyAccessForTenant(tenant);
  if (!accessToken) return destino('token');

  const purchase = await db.creditPurchase.create({
    data: {
      tenantId: auth.tenantId,
      packId: pack.id,
      shipments: pack.shipments,
      pricePerShipmentUyu: pack.pricePerShipmentUyu,
      totalPriceUyu: usdMilliToUyuWhole(BigInt(pack.totalPriceUsdMilli), rateMilli),
      status: 'PENDING',
      mpExternalRef: `shopify|${crypto.randomUUID()}`,
    },
  });

  try {
    // 🔴 RED DE SEGURIDAD, antes de cobrar. Los webhooks se registran al
    // instalar y son por tienda: una tienda conectada ANTES de que existiera
    // este riel no tiene `app_purchases_one_time/update`, y el modo de fallo
    // es el peor posible —el comerciante paga y no se le acredita nada—.
    // `registerShopifyWebhooks` es idempotente: si ya está, es una consulta y
    // ninguna mutación. Va best-effort porque una falla acá no debe impedir
    // la compra: el retorno del comerciante acredita igual.
    await registerShopifyWebhooks(shop, accessToken, appUrl, ['app_purchases_one_time/update'])
      .then((r) => {
        if (r.failed.length) {
          console.warn(
            `[shopify-billing] no se pudo asegurar el webhook de cobro shop=${shop}: ${JSON.stringify(r.failed).slice(0, 200)}`,
          );
        }
      })
      .catch((e) => console.warn(`[shopify-billing] registro de webhook falló: ${(e as Error).message}`));

    // Tienda de desarrollo → cargo de prueba. El revisor de Shopify prueba en
    // una dev store: sin esto tendría que aprobar un cobro real para testear.
    const test = await isDevelopmentStore(shop, accessToken);

    const charge = await createOneTimeCharge({
      shop,
      accessToken,
      name: `AutoEnvía · ${pack.shipments} envíos`,
      totalUsdMilli: pack.totalPriceUsdMilli,
      returnUrl: `${appUrl}/api/credit-packs/shopify-return?purchase=${purchase.id}`,
      test,
    });

    await db.creditPurchase.update({
      where: { id: purchase.id },
      data: { mpPreferenceId: charge.chargeId, mpExternalRef: `shopify|${purchase.id}` },
    });

    console.info(
      `[shopify-billing] cargo creado purchase=${purchase.id} pack=${pack.id} charge=${charge.chargeId} test=${test}`,
    );
    return NextResponse.redirect(charge.confirmationUrl);
  } catch (err) {
    await db.creditPurchase
      .update({ where: { id: purchase.id }, data: { status: 'FAILED' } })
      .catch(() => {});
    const detail = err instanceof ShopifyBillingError ? err.detail : (err as Error).message;
    console.error(`[shopify-billing] no se pudo crear el cargo purchase=${purchase.id}: ${detail}`);
    // El "no sé si es tienda de desarrollo" tiene su propio mensaje: no se
    // creó ningún cargo y reintentar alcanza. El genérico queda para el resto.
    return destino(err instanceof ShopifyPlanUnresolvedError ? 'verificacion_tienda' : 'cobro_shopify');
  }
}
