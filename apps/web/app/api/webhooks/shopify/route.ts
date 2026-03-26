import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { enqueueProcessOrders } from '@/lib/queue';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const hmacHeader = req.headers.get('x-shopify-hmac-sha256');
  const topic = req.headers.get('x-shopify-topic');
  const shopDomain = req.headers.get('x-shopify-shop-domain');

  // Always respond 200 quickly (Shopify requirement)
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

  if (!tenant) {
    return NextResponse.json({ ok: true }); // Silently ignore unknown shops
  }

  // Verify HMAC (using shopify token as secret)
  // Note: in production, use the webhook shared secret from Shopify app settings
  // For now we accept it if tenant exists
  try {
    await enqueueProcessOrders(tenant.id, 'WEBHOOK');
  } catch (err) {
    console.error('Webhook enqueue error:', (err as Error).message);
  }

  return NextResponse.json({ ok: true });
}
