import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { settlePaidPurchase, refundPaidPurchase } from '@/lib/credit-accrual';
import { verifyStandardWebhookSignature } from '@/lib/whop';

/**
 * Webhook de Whop (D34). Contrato: docs/SELFSERVE-SPEC.md §7.5.
 *
 * Orden de defensas, fail-closed en cada una:
 *   1. Sin `WHOP_WEBHOOK_SECRET` → 503 (nunca se procesa sin firma).
 *   2. Standard Webhooks: headers, timestamp ±5 min, HMAC base64 timing-safe → 401.
 *   3. JSON inválido → 400.
 *   4. Dedupe por entrega: WebhookReceipt(source='whop', topic, webhookId) → 200 duplicate.
 *   5. Sólo `payment.succeeded` acredita; refund/dispute reembolsan; el resto se ignora.
 *   6. La compra se resuelve por metadata.purchaseId → metadata.userId → email del
 *      pago + única PENDING de Whop en 24 h. Cualquier ambigüedad = NO se acredita
 *      (200 `flagged`, queda en el log para acreditar a mano).
 *   7. Acreditación por `settlePaidPurchase` (la misma de MP), con
 *      `mpPaymentId = whop:<pay_id>` como idempotencia por pago. El 200 se
 *      devuelve DESPUÉS de acreditar.
 *
 * Logs: sólo ids y cantidades. Nunca el cuerpo, ni el email, ni headers.
 */

const PAYMENT_OK = new Set(['payment.succeeded', 'payment_succeeded']);
const PAYMENT_REFUND = new Set([
  'payment.refunded',
  'payment_refunded',
  'refund.created',
  'refund_created',
  'dispute.created',
  'dispute_created',
]);

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[whop] WHOP_WEBHOOK_SECRET no está configurado — se rechaza el webhook');
    return NextResponse.json({ error: 'Service not configured' }, { status: 503 });
  }

  const webhookId = req.headers.get('webhook-id');
  const verified = verifyStandardWebhookSignature({
    secret,
    webhookId,
    timestamp: req.headers.get('webhook-timestamp'),
    signatureHeader: req.headers.get('webhook-signature'),
    rawBody,
  });
  if (!verified.ok || !webhookId) {
    console.error(`[whop] firma inválida (${verified.ok ? 'sin id' : verified.reason})`);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: Json;
  try {
    const parsed = asObject(JSON.parse(rawBody));
    if (!parsed) throw new Error('not an object');
    body = parsed;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = asString(body.type) ?? asString(body.action) ?? asString(body.event) ?? 'unknown';
  const data = asObject(body.data) ?? {};

  // Dedupe por entrega. Si el procesamiento falla más abajo se borra el
  // recibo para que el reintento de Whop no muera como "duplicado".
  try {
    await db.webhookReceipt.create({
      data: { source: 'whop', topic: eventType, webhookId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error('[whop] no se pudo registrar el recibo del webhook:', (err as Error).message);
  }

  try {
    if (PAYMENT_OK.has(eventType)) {
      return await handlePaymentSucceeded(data, webhookId, eventType);
    }
    if (PAYMENT_REFUND.has(eventType)) {
      return await handleRefund(data, webhookId, eventType);
    }
    return NextResponse.json({ ok: true, ignored: true });
  } catch (err) {
    console.error(`[whop] error procesando ${eventType} webhookId=${webhookId}:`, (err as Error).message);
    await db.webhookReceipt
      .deleteMany({ where: { source: 'whop', topic: eventType, webhookId } })
      .catch(() => {});
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}

async function handlePaymentSucceeded(data: Json, webhookId: string, eventType: string) {
  const paymentId = asString(data.id);
  if (!paymentId) {
    console.warn('[whop] evento sin payment id', { webhookId, eventType });
    return NextResponse.json({ ok: true, flagged: true });
  }

  const purchaseId = await resolvePurchaseId(data, webhookId, paymentId);
  if (!purchaseId) {
    return NextResponse.json({ ok: true, flagged: true });
  }

  const result = await settlePaidPurchase({
    purchaseId,
    externalPaymentId: `whop:${paymentId}`,
    rail: 'whop',
  });

  if (result.credited) {
    console.info(
      `[whop] acreditado webhookId=${webhookId} paymentId=${paymentId} purchaseId=${purchaseId} holderTenantId=${result.holderTenantId} shipments=${result.shipments}`,
    );
    return NextResponse.json({ received: true, credited: true });
  }
  console.info(
    `[whop] no acreditado (${result.reason}) webhookId=${webhookId} paymentId=${paymentId} purchaseId=${purchaseId}`,
  );
  return NextResponse.json({ received: true, credited: false, reason: result.reason });
}

async function handleRefund(data: Json, webhookId: string, eventType: string) {
  const payment = asObject(data.payment);
  const paymentId = asString(data.payment_id) ?? asString(payment?.id) ?? asString(data.id);
  if (!paymentId) {
    console.warn('[whop] evento de reembolso sin payment id', { webhookId, eventType });
    return NextResponse.json({ ok: true, flagged: true });
  }
  const purchase = await db.creditPurchase.findUnique({
    where: { mpPaymentId: `whop:${paymentId}` },
    select: { id: true },
  });
  if (!purchase) {
    console.warn('[whop] reembolso de un pago que no acreditó nada', { webhookId, paymentId });
    return NextResponse.json({ ok: true, ignored: true });
  }
  const r = await refundPaidPurchase(purchase.id, 'whop');
  console.info(
    `[whop] reembolso webhookId=${webhookId} paymentId=${paymentId} purchaseId=${purchase.id} refunded=${r.refunded} debited=${r.debited}`,
  );
  return NextResponse.json({ received: true, refunded: r.refunded });
}

/**
 * Encuentra la compra PENDING que corresponde al pago. Fail-closed: si hay
 * cero o más de una candidata, devuelve null y NO se acredita.
 */
async function resolvePurchaseId(data: Json, webhookId: string, paymentId: string): Promise<string | null> {
  const metadata = asObject(data.metadata) ?? {};

  // 1. metadata.purchaseId (si algún día el checkout lo manda).
  const metaPurchaseId = asString(metadata.purchaseId);
  if (metaPurchaseId) {
    const p = await db.creditPurchase.findFirst({
      where: { id: metaPurchaseId, mpExternalRef: { startsWith: 'whop|' } },
      select: { id: true },
    });
    if (p) return p.id;
    console.warn('[whop] metadata.purchaseId no corresponde a una compra de Whop', { webhookId, paymentId });
    return null;
  }

  // 2. Usuario: metadata.userId, si no el email del pago.
  let userId: string | null = null;
  const metaUserId = asString(metadata.userId);
  if (metaUserId) {
    const u = await db.user.findUnique({ where: { id: metaUserId }, select: { id: true } });
    userId = u?.id ?? null;
  }
  if (!userId) {
    const userObj = asObject(data.user);
    const email = (asString(userObj?.email) ?? asString(data.user_email) ?? asString(data.email))?.toLowerCase();
    if (email) {
      const u = await db.user.findUnique({ where: { email }, select: { id: true } });
      userId = u?.id ?? null;
    }
  }
  if (!userId) {
    console.warn('[whop] compra no resuelta: usuario no identificable', { webhookId, paymentId });
    return null;
  }

  // 3. Única PENDING de Whop de ese usuario en las últimas 24 h.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const packId = asString(metadata.packId);
  const candidates = await db.creditPurchase.findMany({
    where: {
      tenant: { userId },
      mpExternalRef: { startsWith: 'whop|' },
      status: 'PENDING',
      createdAt: { gte: since },
      ...(packId ? { packId } : {}),
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
  if (candidates.length !== 1) {
    console.warn('[whop] compra no resuelta', { webhookId, paymentId, candidates: candidates.length });
    return null;
  }
  return candidates[0].id;
}

/** Paridad con MP: Whop puede pegarle un GET para ver si la URL responde. */
export async function GET() {
  return NextResponse.json({ ok: true });
}
