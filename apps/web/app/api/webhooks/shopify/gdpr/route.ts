import { NextRequest, NextResponse } from 'next/server';
import { Prisma, GdprRequestTopic } from '@prisma/client';
import { db } from '@/lib/db';
import { verifyShopifyWebhook } from '@/lib/shopify-webhook';

/**
 * Shopify mandatory GDPR / privacy webhooks (C-5, 2026-04-21 audit).
 *
 * A single endpoint handles all three topics Shopify requires for App Store
 * approval, keyed off the `x-shopify-topic` header:
 *
 *   - customers/data_request — customer (via merchant) asks for their data.
 *     We persist the request and let the operator fulfill it within 30
 *     days (export + email to merchant). Shopify only requires us to
 *     acknowledge receipt with 200 OK.
 *
 *   - customers/redact       — merchant asks us to delete a specific
 *     customer's data. Again, 30 days to comply; we record the request
 *     and let the operator (or a future sweeper) do the actual redaction.
 *
 *   - shop/redact            — fires 48h after an app uninstall. We have
 *     30 days to delete all data for that shop. Recorded here; actual
 *     tenant + relation purge is operator-driven for now (safer than
 *     wiring automatic cascade-delete into a webhook handler).
 *
 * Security posture (matches orders/paid and checkouts routes):
 *   1. Verify HMAC with SHOPIFY_API_SECRET BEFORE any DB I/O (prevents
 *      tenant enumeration via timing/response differences). La firma es lo
 *      único que produce un 401.
 *   2. Recién después se exigen los headers de contexto; si faltan en una
 *      petición firmada se acusa recibo con 200 (ver el comentario en POST).
 *   3. Idempotency via WebhookReceipt — Shopify retries for 48h on any
 *      non-200 or slow reply, and a compliance record must not be
 *      double-inserted.
 *   4. Persist the payload verbatim in GdprRequest for audit; fulfillment
 *      is a separate concern tracked via status.
 */

const TOPIC_TO_ENUM: Record<string, GdprRequestTopic> = {
  'customers/data_request': GdprRequestTopic.CUSTOMERS_DATA_REQUEST,
  'customers/redact': GdprRequestTopic.CUSTOMERS_REDACT,
  'shop/redact': GdprRequestTopic.SHOP_REDACT,
};

export async function POST(req: NextRequest) {
  const body = await req.text();
  const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
  const topicHeader = req.headers.get('x-shopify-topic');
  const shopDomain = req.headers.get('x-shopify-shop-domain');
  const webhookId = req.headers.get('x-shopify-webhook-id');

  // 🔴 La firma es lo ÚNICO que decide 401. Los headers de contexto se exigen
  // DESPUÉS, y su ausencia no es un error de autenticación.
  //
  // La comprobación automática del App Store manda una sonda firmada con el
  // secreto de la app pero sin `x-shopify-topic` ni `x-shopify-shop-domain`.
  // Cuando esos headers se exigían acá arriba, la sonda recibía 401 y Shopify
  // marcaba en rojo LOS DOS chequeos a la vez —«proporciona webhooks de
  // cumplimiento obligatorios» y «verifica webhooks con firmas HMAC»— porque
  // desde afuera la app parecía rechazar todo. Una petición legítimamente
  // firmada por Shopify no puede contestarse con un error de autenticación.
  //
  // La propiedad de seguridad no se afloja: sigue sin haber I/O de base antes
  // de verificar, así que tampoco hay enumeración de tenants por timing.
  if (!verifyShopifyWebhook(body, hmacHeader)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Firmada, pero sin la tienda o el tema no hay nada que registrar: se acusa
  // recibo con 200 para que Shopify no reintente 48 horas.
  if (!topicHeader || !shopDomain) {
    return NextResponse.json({ ok: true, ignored: 'missing-context-headers' });
  }

  const topic = TOPIC_TO_ENUM[topicHeader];
  if (!topic) {
    // Signed but not a topic this route owns. Return 200 so Shopify doesn't
    // retry; the orders webhook endpoint handles orders/paid etc.
    return NextResponse.json({ ok: true, ignored: topicHeader });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Tenant is looked up post-HMAC. `shop/redact` can arrive AFTER the
  // merchant uninstalled the app, at which point isActive=false or the
  // tenant row is already gone. We persist the GdprRequest either way —
  // the compliance record must exist even if we have nothing left to
  // redact for that shop.
  //
  // Insensible a mayúsculas (D18): el camino manual pudo guardar el dominio
  // con mayúsculas; Shopify lo manda en minúsculas. Sin esto el GdprRequest
  // quedaba sin tenantId para esa tienda.
  const tenant = await db.tenant.findFirst({
    where: { shopifyStoreUrl: { equals: shopDomain, mode: 'insensitive' } },
    select: { id: true },
  });

  // Idempotency — same pattern as orders/paid and checkouts routes.
  if (webhookId) {
    try {
      await db.webhookReceipt.create({
        data: {
          source: 'shopify',
          topic: topicHeader,
          webhookId,
          shopDomain,
          tenantId: tenant?.id ?? null,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return NextResponse.json({ ok: true, duplicate: true });
      }
      console.error('[GDPR Webhook] WebhookReceipt insert failed:', err);
    }
  }

  // Extract customer hints for operator convenience. Shopify payload shapes:
  //   customers/data_request: { customer: { id, email, phone }, ... }
  //   customers/redact:       { customer: { id, email, phone }, ... }
  //   shop/redact:            { shop_id, shop_domain }
  const customer = payload.customer as Record<string, unknown> | undefined;
  const customerId =
    customer?.id != null ? String(customer.id) : null;
  const customerEmail =
    typeof customer?.email === 'string' ? (customer.email as string) : null;

  try {
    await db.gdprRequest.create({
      data: {
        topic,
        shopDomain,
        tenantId: tenant?.id ?? null,
        customerId,
        customerEmail,
        payload: payload as Prisma.InputJsonValue,
        webhookId: webhookId ?? null,
      },
    });
  } catch (err) {
    // Persistence failure is serious for compliance — log loudly, but still
    // ACK 200. If we return 5xx Shopify will retry and eventually mark our
    // webhook failing; a retry storm is worse than a single missed row
    // (which will show up as a webhook-receipt with no matching gdprRequest
    // in the audit query).
    console.error('[GDPR Webhook] Failed to persist GdprRequest:', err);
  }

  console.info(
    `[GDPR] ${topicHeader} received for shop=${shopDomain} ` +
      `customer=${customerEmail ?? customerId ?? 'n/a'} — status=PENDING`,
  );

  return NextResponse.json({ ok: true });
}
