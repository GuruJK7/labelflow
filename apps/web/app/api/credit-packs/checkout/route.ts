import { NextRequest, NextResponse } from 'next/server';
import { getPreferenceClient } from '@/lib/mercadopago';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';
import { getPack, packIdList } from '@/lib/credit-packs';
import { formatRate, formatUsdMilli, getUsdUyuRateMilli } from '@/lib/pricing';

/**
 * Inicia un checkout de pack de envíos. Diseño:
 *
 *   1. Validamos sesión y pack existente (defensa contra precios inyectados).
 *   2. Creamos un row CreditPurchase con status=PENDING y un external_reference
 *      único `pkg|<purchaseId>`. Esto es la clave que MP nos devuelve en el
 *      webhook — más estable que payerEmail/preferenceId.
 *   3. Creamos la Preference de MP con el item del pack.
 *   4. Guardamos `mpPreferenceId` y redirigimos al init_point.
 *
 * Diferencia clave con el flow viejo (`/api/mercadopago/checkout`):
 *   - PreApproval (recurring) → Preference (pago único). MercadoPago no
 *     intentará cobrar de nuevo automáticamente al mes siguiente.
 *
 * PRECIO (D35): el pack se denomina en DÓLARES (`lib/pricing.ts`) y acá se
 * convierte a pesos enteros con `USD_UYU_RATE` (default 40 UYU/USD). El monto
 * cobrado y el tipo de cambio usado quedan congelados en la fila del
 * `CreditPurchase`: si mañana cambia la env, esta compra no se revalúa.
 *
 * Idempotencia: este endpoint puede crear múltiples PENDING para el mismo
 * tenant si el usuario clickea varias veces. Eso es aceptable porque
 * mpPaymentId es único: solo una compra puede transicionar a PAID por
 * notificación de MP. Las PENDING viejas quedan como audit y se pueden
 * limpiar después con un sweeper.
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
    select: { id: true, name: true, userId: true },
  });
  if (!tenant) return apiError('Tenant no encontrado', 404);

  const user = await db.user.findUnique({
    where: { id: tenant.userId },
    select: { email: true, name: true },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const rateMilli = getUsdUyuRateMilli();

  // Crear PENDING purchase ANTES de hablar con MP. Si MP falla, el row
  // queda en PENDING y nunca pasa a PAID — no es deuda.
  const purchase = await db.creditPurchase.create({
    data: {
      tenantId: auth.tenantId,
      packId: pack.id,
      shipments: pack.shipments,
      pricePerShipmentUyu: pack.pricePerShipmentUyu,
      totalPriceUyu: pack.totalPriceUyu,
      status: 'PENDING',
      // external_reference único; el webhook lo usa para encontrar este row
      mpExternalRef: `pkg|${makeExternalRefSuffix()}`,
    },
  });

  // MP requiere que sea un string corto, sin pipes — ajusto el formato a
  // `pkg|<purchaseId>` para que el handler pueda hacer split.
  const externalRef = `pkg|${purchase.id}`;
  await db.creditPurchase.update({
    where: { id: purchase.id },
    data: { mpExternalRef: externalRef },
  });

  try {
    const preference = getPreferenceClient();

    const result = await preference.create({
      body: {
        items: [
          {
            id: pack.id,
            // Marca: adentro de la app el producto se llama AutoEnvía (PR #12);
            // el comerciante ve ese nombre en el checkout de MercadoPago.
            title: `AutoEnvía - Pack ${pack.shipments} envíos`,
            // El precio está denominado en dólares (D35); MercadoPago cobra en
            // pesos, así que la descripción deja constancia del tipo de cambio
            // con el que se convirtió ESTE cobro. `unit_price` va en pesos
            // enteros: el redondeo ya lo hizo `usdMilliToUyuWhole`.
            description:
              `${pack.shipments} envíos a USD ${formatUsdMilli(BigInt(pack.pricePerShipmentUsdMilli))} c/u ` +
              `— USD ${formatUsdMilli(BigInt(pack.totalPriceUsdMilli))} al tipo de cambio ` +
              `${formatRate(rateMilli)} UYU/USD`,
            quantity: 1,
            currency_id: 'UYU',
            unit_price: pack.totalPriceUyu,
          },
        ],
        payer: {
          email: user?.email ?? undefined,
          name: user?.name ?? undefined,
        },
        external_reference: externalRef,
        back_urls: {
          success: `${appUrl}/settings/billing?success=true`,
          failure: `${appUrl}/settings/billing?error=true`,
          pending: `${appUrl}/settings/billing?pending=true`,
        },
        auto_return: 'approved',
        notification_url: `${appUrl}/api/webhooks/mercadopago`,
        statement_descriptor: 'LABELFLOW',
        // Sin auto-renovación: pago único.
      },
    });

    if (!result.id || !result.init_point) {
      console.error('[CREDIT-PACKS] No init_point en preference:', JSON.stringify(result));
      // Marcamos el purchase como FAILED para no dejar PENDING fantasma
      await db.creditPurchase.update({
        where: { id: purchase.id },
        data: { status: 'FAILED' },
      });
      return apiError('Error al crear el checkout', 500);
    }

    await db.creditPurchase.update({
      where: { id: purchase.id },
      data: { mpPreferenceId: result.id },
    });

    return NextResponse.redirect(result.init_point);
  } catch (err) {
    await db.creditPurchase.update({
      where: { id: purchase.id },
      data: { status: 'FAILED' },
    });
    console.error('[CREDIT-PACKS] Checkout error:', (err as Error).message, (err as Error).stack);
    return apiError('Error al procesar el pago. Intenta de nuevo.', 500);
  }
}

/**
 * Random suffix temporal — el mpExternalRef se sobrescribe inmediatamente
 * después con `pkg|<purchaseId>` (que es definitivo). Solo existe porque
 * el campo es @unique y no podemos crear el row sin un valor.
 */
function makeExternalRefSuffix(): string {
  return `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
