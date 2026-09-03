import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { verifyShopifyWebhook } from '@/lib/shopify-webhook';
import { isDeadStatus, isPaidStatus } from '@/lib/shopify-billing';
import { settlePaidPurchase } from '@/lib/credit-accrual';

/**
 * `app_purchases_one_time/update` — el aviso de Shopify de que un cargo único
 * cambió de estado. Es la fuente AUTORITATIVA de la acreditación; el retorno
 * del comerciante (`/api/credit-packs/shopify-return`) es el atajo para que
 * vea el saldo al instante. Los dos llaman a `settlePaidPurchase`, que es
 * idempotente, así que el segundo no acredita de nuevo.
 *
 * SEGURIDAD, en este orden y por estos motivos:
 *   1. HMAC con el secreto de la app ANTES de tocar la base. Sin esto,
 *      cualquiera que adivine un GID se acredita envíos gratis. Es el mismo
 *      criterio que el webhook de pedidos (auditoría C-1/C-2).
 *   2. El monto y la cantidad de envíos NO se leen del cuerpo del webhook:
 *      salen de la fila `CreditPurchase` que creamos nosotros. El cuerpo sólo
 *      dice QUÉ cargo cambió y a qué estado.
 *   3. La compra se busca por el GID guardado en `mpPreferenceId`, que
 *      escribimos al crear el cargo. Un GID que no conocemos se ignora con
 *      200 (Shopify deja de reintentar) y queda en el log.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const hmac = req.headers.get('x-shopify-hmac-sha256');
  const topic = req.headers.get('x-shopify-topic');
  const shopDomain = req.headers.get('x-shopify-shop-domain');
  const webhookId = req.headers.get('x-shopify-webhook-id');

  // 🔴 La firma es lo único que produce un 401. Los headers de contexto se
  // exigen DESPUÉS: una petición firmada por Shopify a la que le falta el topic
  // o el dominio no es un intento de autenticación fallido, y contestarle 401
  // hace que la comprobación automática del App Store marque en rojo
  // «verifica webhooks con firmas HMAC». Ver el comentario largo en
  // app/api/webhooks/shopify/gdpr/route.ts.
  if (!hmac) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  if (!verifyShopifyWebhook(body, hmac)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  if (!topic || !shopDomain) {
    return NextResponse.json({ ok: true, ignored: 'missing-context-headers' });
  }
  if (topic !== 'app_purchases_one_time/update') {
    return NextResponse.json({ ok: true, ignored: topic });
  }

  if (webhookId) {
    try {
      await db.webhookReceipt.create({
        data: { source: 'shopify', topic, webhookId, shopDomain },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return NextResponse.json({ ok: true, duplicate: true });
      }
      console.error('[shopify-billing] WebhookReceipt insert falló:', (err as Error).message);
    }
  }

  let payload: { app_purchase_one_time?: { admin_graphql_api_id?: string; status?: string } };
  try {
    payload = JSON.parse(body);
  } catch {
    console.warn('[shopify-billing] webhook con cuerpo ilegible');
    return NextResponse.json({ ok: true, flagged: true });
  }

  const charge = payload.app_purchase_one_time;
  const chargeId = charge?.admin_graphql_api_id;
  // Shopify manda el estado en minúsculas en el cuerpo REST del webhook
  // ("active"), y en mayúsculas en GraphQL. Se normaliza para comparar con el
  // enum documentado en vez de adivinar cuál de los dos llega.
  const status = charge?.status ? charge.status.toUpperCase() : null;

  if (!chargeId) {
    console.warn('[shopify-billing] webhook sin admin_graphql_api_id');
    return NextResponse.json({ ok: true, flagged: true });
  }

  const purchase = await db.creditPurchase.findFirst({
    where: { mpPreferenceId: chargeId },
    select: { id: true, status: true },
  });
  if (!purchase) {
    console.warn(`[shopify-billing] cargo desconocido charge=${chargeId} shop=${shopDomain}`);
    return NextResponse.json({ ok: true, unknown: true });
  }

  if (isPaidStatus(status)) {
    const res = await settlePaidPurchase({
      purchaseId: purchase.id,
      externalPaymentId: `shopify:${chargeId}`,
      rail: 'shopify',
    });
    console.info(
      `[shopify-billing] webhook purchase=${purchase.id} charge=${chargeId} credited=${res.credited}`,
    );
    return NextResponse.json({ received: true, credited: res.credited });
  }

  if (isDeadStatus(status)) {
    // Sólo se mueve si sigue PENDING: una compra ya PAID no se desacredita
    // por un evento tardío.
    await db.creditPurchase
      .updateMany({ where: { id: purchase.id, status: 'PENDING' }, data: { status: 'FAILED' } })
      .catch(() => {});
    console.info(`[shopify-billing] cargo ${status} purchase=${purchase.id}`);
    return NextResponse.json({ received: true, credited: false, status });
  }

  return NextResponse.json({ received: true, credited: false, status });
}
