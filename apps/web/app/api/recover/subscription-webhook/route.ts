import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getPreApprovalClient } from '@/lib/mercadopago';
import { db } from '@/lib/db';

function verifyMercadoPagoSignature(
  req: NextRequest,
  body: string,
  secret: string
): boolean {
  const xSignature = req.headers.get('x-signature');
  const xRequestId = req.headers.get('x-request-id');
  if (!xSignature || !xRequestId) return false;

  const parts = xSignature.split(',');
  const ts = parts.find((p) => p.startsWith('ts='))?.split('=')[1];
  const v1 = parts.find((p) => p.startsWith('v1='))?.split('=')[1];
  if (!ts || !v1) return false;

  let dataId: string | undefined;
  try {
    dataId = JSON.parse(body)?.data?.id;
  } catch {
    return false;
  }

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  // Timing-safe compare: NEVER use === on HMAC digests (timing oracle).
  try {
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(v1, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// POST /api/recover/subscription-webhook — MercadoPago subscription lifecycle for Recover module
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Signature verification is MANDATORY. Fail closed when env is missing —
  // the previous `if (webhookSecret)` was an open-by-default vulnerability:
  // an attacker could activate Recover for arbitrary tenants if the env var
  // happened to be unset.
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[Recover Webhook] MERCADOPAGO_WEBHOOK_SECRET not set — rejecting');
    return NextResponse.json({ error: 'Service not configured' }, { status: 503 });
  }
  if (!verifyMercadoPagoSignature(req, rawBody, webhookSecret)) {
    console.warn('[Recover Webhook] Invalid MercadoPago signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const type = body.type as string | undefined;

  if (type === 'subscription_preapproval' && body.data) {
    const preapprovalId = (body.data as Record<string, unknown>).id as string | undefined;
    if (preapprovalId) {
      await handlePreApprovalNotification(preapprovalId);
    }
  }

  // Legacy IPN format
  const topic = req.nextUrl.searchParams.get('topic');
  const id = req.nextUrl.searchParams.get('id');
  if (topic === 'preapproval' && id) {
    await handlePreApprovalNotification(id);
  }

  return NextResponse.json({ received: true });
}

export async function GET() {
  return NextResponse.json({ status: 'ok' });
}

async function handlePreApprovalNotification(preapprovalId: string): Promise<void> {
  const preApprovalClient = getPreApprovalClient();

  let preapproval;
  try {
    preapproval = await preApprovalClient.get({ id: preapprovalId });
  } catch (err) {
    console.error(
      `[Recover Webhook] Failed to fetch preapproval ${preapprovalId}:`,
      (err as Error).message
    );
    return;
  }

  if (!preapproval) return;

  const status = preapproval.status as string | undefined;
  const externalReference = preapproval.external_reference as string | undefined;

  // Only handle Recover subscriptions (external_reference ends in "|recover")
  if (!externalReference?.endsWith('|recover')) return;

  const tenantId = externalReference.split('|')[0];
  if (!tenantId) return;

  // Verificar que el tenantId existe ANTES de cualquier write. Sin esto un
  // atacante con HMAC válido podría inyectar tenantIds inventados y crear
  // RecoverConfig huérfanos en la DB.
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) {
    console.warn(`[Recover Webhook] tenant ${tenantId} not found — skipping`);
    return;
  }

  // Map MercadoPago status to our RecoverSubscriptionStatus
  const statusMap: Record<string, 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'CANCELLED'> = {
    authorized: 'ACTIVE',
    pending: 'INACTIVE',
    paused: 'PAUSED',
    cancelled: 'CANCELLED',
  };

  const newStatus = statusMap[status ?? ''] ?? 'INACTIVE';

  // Upsert the RecoverConfig with subscription info
  const existing = await db.recoverConfig.findUnique({
    where: { tenantId },
  });

  if (existing) {
    await db.recoverConfig.update({
      where: { tenantId },
      data: {
        subscriptionId: preapprovalId,
        subscriptionStatus: newStatus,
        isActive: newStatus === 'ACTIVE',
      },
    });
  } else {
    await db.recoverConfig.create({
      data: {
        tenantId,
        subscriptionId: preapprovalId,
        subscriptionStatus: newStatus,
        isActive: newStatus === 'ACTIVE',
      },
    });
  }

  console.warn(
    `[Recover Webhook] Subscription ${preapprovalId} for tenant ${tenantId} -> ${newStatus}`
  );
}
