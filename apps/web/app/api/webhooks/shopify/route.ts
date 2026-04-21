import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { enqueueProcessOrders } from '@/lib/queue';
import { verifyShopifyWebhook } from '@/lib/shopify-webhook';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
  const topic = req.headers.get('x-shopify-topic');
  const shopDomain = req.headers.get('x-shopify-shop-domain');

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

  try {
    await enqueueProcessOrders(tenant.id, 'WEBHOOK');
  } catch {
    // Silently handle — Shopify requires fast 200 response
  }

  return NextResponse.json({ ok: true });
}
