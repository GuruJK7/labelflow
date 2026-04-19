import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { enqueueProcessOrders } from '@/lib/queue';

function verifyHmac(body: string, hmacHeader: string, secret: string): boolean {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmacHeader, 'base64'),
      Buffer.from(digest, 'base64')
    );
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
  const topic = req.headers.get('x-shopify-topic');
  const shopDomain = req.headers.get('x-shopify-shop-domain');

  if (!hmacHeader || !topic || !shopDomain) {
    return NextResponse.json({ error: 'Missing headers' }, { status: 401 });
  }

  // Verify HMAC using the app's client secret (shared across all shops).
  // Shopify signs all webhook payloads with the app's API secret key — NOT
  // the per-shop access token. See:
  // https://shopify.dev/docs/api/admin-rest/webhooks#verify-a-webhook
  const webhookSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!webhookSecret) {
    console.error('Shopify: SHOPIFY_CLIENT_SECRET is not set — rejecting webhook');
    return NextResponse.json({ error: 'Service not configured' }, { status: 503 });
  }

  if (!verifyHmac(body, hmacHeader, webhookSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Only process order/paid events
  if (topic !== 'orders/paid') {
    return NextResponse.json({ ok: true });
  }

  // Find tenant by shop domain
  const tenant = await db.tenant.findFirst({
    where: {
      shopifyStoreUrl: shopDomain,
      isActive: true,
      subscriptionStatus: 'ACTIVE',
    },
    select: { id: true },
  });

  if (!tenant) {
    return NextResponse.json({ ok: true });
  }

  try {
    await enqueueProcessOrders(tenant.id, 'WEBHOOK');
  } catch {
    // Silently handle — Shopify requires fast 200 response
  }

  return NextResponse.json({ ok: true });
}
