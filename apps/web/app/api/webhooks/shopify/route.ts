import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { enqueueProcessOrders } from '@/lib/queue';
import { verifyShopifyWebhook } from '@/lib/shopify-webhook';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
  const topic = req.headers.get('x-shopify-topic');
  const shopDomain = req.headers.get('x-shopify-shop-domain');
  const webhookId = req.headers.get('x-shopify-webhook-id');

  if (!hmacHeader || !topic || !shopDomain) {
    return NextResponse.json({ error: 'Missing headers' }, { status: 401 });
  }

  // C-1/C-2 (2026-04-21 audit):
  //  - C-1: verify with the app shared secret (SHOPIFY_API_SECRET), not the
  //    per-tenant Admin API access token. Shopify signs webhooks with the
  //    app-level secret; verifying with the access token rejected legitimate
  //    traffic and (inversely) would accept forged payloads from anyone who
  //    had ever leaked an access token.
  //  - C-2: verify BEFORE the tenant lookup. Doing the tenant lookup first
  //    let attackers enumerate valid shop domains by probing the endpoint
  //    and observing timing/response differences.
  if (!verifyShopifyWebhook(body, hmacHeader)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Only process order/paid events
  if (topic !== 'orders/paid') {
    return NextResponse.json({ ok: true });
  }

  // Tenant lookup happens AFTER HMAC passes — untrusted shopDomain header is
  // now safe to use as a DB filter since we've proven Shopify (with our app
  // secret) actually signed this payload.
  const tenant = await db.tenant.findFirst({
    where: {
      shopifyStoreUrl: shopDomain,
      isActive: true,
      subscriptionStatus: 'ACTIVE',
    },
    select: { id: true },
  });

  if (!tenant) {
    // Signature valid but we don't recognise the shop (e.g. uninstalled). Return
    // 200 so Shopify stops retrying; nothing to do on our side.
    return NextResponse.json({ ok: true });
  }

  // C-3 (2026-04-21 audit): idempotency. Shopify retries webhooks for up to 48h
  // on any response slower than 5s or not-200. Without this guard, a slow
  // response to `orders/paid` for the same order could enqueue the job twice
  // and produce duplicate DAC guías.
  //
  // Pattern: try to INSERT a receipt row; a P2002 unique violation means
  // "already processed — ACK 200, do nothing." The unique key is
  // (source, topic, webhookId) so re-delivery of the SAME Shopify webhook is
  // deduped, but different events with the same shop/order ID are NOT (that's
  // what `tenantId` is for in logs/debug).
  //
  // If the `x-shopify-webhook-id` header is missing (edge case: Shopify only
  // guarantees it post-2021), we fall through without deduping — better to
  // process a possible duplicate than to drop a legitimate webhook.
  if (webhookId) {
    try {
      await db.webhookReceipt.create({
        data: {
          source: 'shopify',
          topic,
          webhookId,
          shopDomain,
          tenantId: tenant.id,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Duplicate delivery — already acked the first one, silently succeed.
        return NextResponse.json({ ok: true, duplicate: true });
      }
      // Any other DB error: log but DON'T fail the webhook (Shopify would
      // retry, causing more duplicates). Best-effort idempotency.
      console.error('[Shopify Webhook] WebhookReceipt insert failed:', err);
    }
  }

  try {
    await enqueueProcessOrders(tenant.id, 'WEBHOOK');
  } catch {
    // Silently handle — Shopify requires fast 200 response
  }

  return NextResponse.json({ ok: true });
}
