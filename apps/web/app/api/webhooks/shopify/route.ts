import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { enqueueProcessOrders } from '@/lib/queue';
import { decrypt } from '@/lib/encryption';

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
    select: { id: true, shopifyToken: true },
  });

  if (!tenant || !tenant.shopifyToken) {
    return NextResponse.json({ ok: true });
  }

  // Verify HMAC using the tenant's Shopify token as webhook secret
  const shopifySecret = decrypt(tenant.shopifyToken);
  if (!verifyHmac(body, hmacHeader, shopifySecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    await enqueueProcessOrders(tenant.id, 'WEBHOOK');
  } catch {
    // Silently handle — Shopify requires fast 200 response
  }

  return NextResponse.json({ ok: true });
}
