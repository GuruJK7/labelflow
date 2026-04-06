import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';

/**
 * Verifies the X-Hub-Signature-256 header sent by Meta on every webhook delivery.
 * Uses the App Secret (WHATSAPP_APP_SECRET) to compute HMAC-SHA256 over the raw body.
 * Returns true if signature matches, or true when secret is not configured (dev only).
 */
function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader) return false;
  const [scheme, digest] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !digest) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// GET /api/webhooks/whatsapp — Meta webhook verification (hub challenge)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const tokenBuf = token ? Buffer.from(token) : Buffer.alloc(0);
  const expectedBuf = verifyToken ? Buffer.from(verifyToken) : Buffer.alloc(0);
  const tokensMatch = tokenBuf.length === expectedBuf.length &&
    tokenBuf.length > 0 &&
    crypto.timingSafeEqual(tokenBuf, expectedBuf);

  if (
    mode === 'subscribe' &&
    tokensMatch &&
    challenge
  ) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// POST /api/webhooks/whatsapp — Message status updates + incoming messages (opt-out)
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Verify Meta signature — REQUIRED in production.
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[WhatsApp Webhook] WHATSAPP_APP_SECRET not set in production — rejecting');
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }
    // Local dev: skip verification
  } else {
    const signatureHeader = req.headers.get('x-hub-signature-256');
    if (!verifyMetaSignature(rawBody, signatureHeader, appSecret)) {
      console.warn('[WhatsApp Webhook] Invalid Meta signature — rejecting request');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const entry = (body?.entry as Array<Record<string, unknown>>)?.[0];
  const changes = (entry?.changes as Array<Record<string, unknown>>)?.[0];
  const value = changes?.value as Record<string, unknown> | undefined;

  if (!value) {
    return NextResponse.json({ ok: true });
  }

  // Update message delivery status (delivered, read, failed)
  const statuses = value.statuses as Array<Record<string, unknown>> | undefined;
  if (statuses?.length) {
    await handleStatusUpdates(statuses);
  }

  // Handle incoming messages (opt-out keyword detection)
  const messages = value.messages as Array<Record<string, unknown>> | undefined;
  if (messages?.length) {
    await handleIncomingMessages(messages);
  }

  return NextResponse.json({ ok: true });
}

async function handleStatusUpdates(
  statuses: Array<Record<string, unknown>>
): Promise<void> {
  for (const statusUpdate of statuses) {
    const waMessageId = statusUpdate.id as string | undefined;
    const status = statusUpdate.status as string | undefined;

    if (!waMessageId || !status) continue;

    const mapped = mapMetaStatus(status);
    if (!mapped) continue;

    await db.recoverMessageLog
      .updateMany({
        where: { whatsappMessageId: waMessageId },
        data: { status: mapped },
      })
      .catch(() => {
        // Non-fatal — log not found is acceptable
      });
  }
}

async function handleIncomingMessages(
  messages: Array<Record<string, unknown>>
): Promise<void> {
  for (const msg of messages) {
    const fromRaw = msg.from as string | undefined;
    if (!fromRaw) continue;

    const fromPhone = fromRaw.startsWith('+') ? fromRaw : `+${fromRaw}`;
    const text = ((msg.text as Record<string, unknown>)?.body as string ?? '').trim().toUpperCase();

    if (!text) continue;

    // Find all active recover configs that match this opt-out keyword
    const matchingConfigs = await db.recoverConfig.findMany({
      where: {
        isActive: true,
        subscriptionStatus: 'ACTIVE',
        optOutKeyword: { equals: text, mode: 'insensitive' },
      },
      select: { id: true, tenantId: true },
    });

    for (const config of matchingConfigs) {
      // Register opt-out
      await db.recoverOptOut
        .upsert({
          where: {
            tenantId_phone: {
              tenantId: config.tenantId,
              phone: fromPhone,
            },
          },
          create: {
            tenantId: config.tenantId,
            phone: fromPhone,
            recoverConfigId: config.id,
          },
          update: {},
        })
        .catch(() => {
          // Non-fatal
        });

      // Cancel pending jobs for this phone
      const pendingCarts = await db.recoverCart.findMany({
        where: {
          tenantId: config.tenantId,
          customerPhone: fromPhone,
          status: { in: ['PENDING', 'MESSAGE_1_SENT'] },
        },
        select: { id: true },
      });

      for (const cart of pendingCarts) {
        await db.recoverJob.updateMany({
          where: { cartId: cart.id, status: 'PENDING' },
          data: { status: 'COMPLETED', finishedAt: new Date() },
        }).catch(() => {});

        await db.recoverCart.update({
          where: { id: cart.id },
          data: { status: 'OPTED_OUT' },
        }).catch(() => {});
      }
    }
  }
}

function mapMetaStatus(status: string): 'DELIVERED' | 'READ' | 'FAILED' | null {
  switch (status) {
    case 'delivered': return 'DELIVERED';
    case 'read': return 'READ';
    case 'failed': return 'FAILED';
    default: return null;
  }
}
