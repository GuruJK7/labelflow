import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getPreApprovalClient, getPaymentClient, PLANS, type PlanId } from '@/lib/mercadopago';
import { db } from '@/lib/db';
import { calcReferralKickback } from '@/lib/credit-packs';

/**
 * Verify MercadoPago webhook signature (x-signature header).
 * See: https://www.mercadopago.com.uy/developers/en/docs/your-integrations/notifications/webhooks
 */
function verifyMercadoPagoSignature(req: NextRequest, body: string, secret: string): boolean {
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

/**
 * MercadoPago webhook handler for subscriptions (preapproval) and payments.
 *
 * MercadoPago sends notifications for:
 * - topic=preapproval: subscription status changes (authorized, paused, cancelled, pending)
 * - topic=payment / type=payment: individual payment within a subscription
 */
export async function POST(req: NextRequest) {
  // Clone the request to read body as text for signature verification
  const rawBody = await req.text();

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Signature verification (mandatory)
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('MercadoPago: MERCADOPAGO_WEBHOOK_SECRET is not set — rejecting webhook');
    return NextResponse.json({ error: 'Service not configured' }, { status: 503 });
  }

  const isValid = verifyMercadoPagoSignature(req, rawBody, webhookSecret);
  if (!isValid) {
    console.error('MercadoPago: webhook signature verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const type = body.type as string | undefined;

  // New-style webhook: { type: "subscription_preapproval", data: { id: "..." } }
  if (type === 'subscription_preapproval' && body.data) {
    const preapprovalId = (body.data as Record<string, unknown>).id as string | undefined;
    if (preapprovalId) {
      await handlePreApprovalNotification(preapprovalId);
    }
  }

  // New-style webhook: { type: "payment", data: { id: "..." } }
  if (type === 'payment' && body.data) {
    const paymentId = (body.data as Record<string, unknown>).id as string | undefined;
    if (paymentId) {
      await handlePaymentNotification(paymentId);
    }
  }

  // Legacy IPN format: topic=preapproval&id=123 or topic=payment&id=123
  const topic = req.nextUrl.searchParams.get('topic');
  const id = req.nextUrl.searchParams.get('id');

  if (topic === 'preapproval' && id) {
    await handlePreApprovalNotification(id);
  }

  if (topic === 'payment' && id) {
    await handlePaymentNotification(id);
  }

  return NextResponse.json({ received: true });
}

/**
 * Handle a preapproval (subscription) status change.
 * Fetches the full preapproval from MercadoPago and updates the tenant accordingly.
 */
async function handlePreApprovalNotification(preapprovalId: string) {
  const preApprovalClient = getPreApprovalClient();

  let preapproval;
  try {
    preapproval = await preApprovalClient.get({ id: preapprovalId });
  } catch (err) {
    console.error(
      `MercadoPago: failed to fetch preapproval ${preapprovalId}:`,
      (err as Error).message
    );
    return;
  }

  if (!preapproval) return;

  const status = preapproval.status as string | undefined;
  const externalReference = preapproval.external_reference as string | undefined;

  let tenantId: string | undefined;
  let planId: string | undefined;

  if (externalReference) {
    const parts = externalReference.split('|');
    tenantId = parts[0];
    planId = parts[1];
  }

  if (!tenantId) {
    console.error('MercadoPago: no tenantId found in preapproval', preapprovalId);
    return;
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });

  if (!tenant) {
    console.error('MercadoPago: tenant not found:', tenantId);
    return;
  }

  switch (status) {
    case 'authorized': {
      const plan = planId ? PLANS[planId as PlanId] : null;

      // Next payment date from MercadoPago, or fallback to 30 days from now
      let currentPeriodEnd: Date;
      if (preapproval.next_payment_date) {
        currentPeriodEnd = new Date(preapproval.next_payment_date);
      } else {
        currentPeriodEnd = new Date();
        currentPeriodEnd.setDate(currentPeriodEnd.getDate() + 30);
      }

      await db.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionStatus: 'ACTIVE',
          isActive: true,
          stripePriceId: planId ?? null,
          stripeSubscriptionId: `mp_sub_${preapprovalId}`,
          stripeCustomerId: preapproval.payer_id?.toString() ?? null,
          currentPeriodEnd,
          labelsThisMonth: 0,
        },
      });

      console.info(
        `MercadoPago: subscription authorized for ${tenantId} on plan ${plan?.tier ?? planId}`
      );
      break;
    }

    case 'pending': {
      console.info(
        `MercadoPago: subscription ${preapprovalId} is pending for tenant ${tenantId}`
      );
      break;
    }

    case 'paused': {
      await db.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionStatus: 'PAST_DUE',
          isActive: false,
        },
      });
      console.info(
        `MercadoPago: subscription paused for tenant ${tenantId}`
      );
      break;
    }

    case 'cancelled': {
      await db.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionStatus: 'CANCELED',
          isActive: false,
          stripeSubscriptionId: null,
        },
      });
      console.info(
        `MercadoPago: subscription cancelled for tenant ${tenantId}`
      );
      break;
    }

    default: {
      console.info(
        `MercadoPago: unhandled preapproval status "${status}" for ${preapprovalId}`
      );
    }
  }
}

/**
 * Handle a payment notification. Dispatch por formato de external_reference:
 *
 *   - "pkg|<purchaseId>"   → credit-pack purchase (modelo nuevo)
 *   - "<tenantId>|<planId>" → suscripción legacy (modelo viejo, en wind-down)
 *
 * Si no hay external_reference (caso típico de subscription payments donde
 * MP no la propaga), confiamos en que el handler de preapproval ya activó
 * al tenant.
 */
async function handlePaymentNotification(paymentId: string) {
  const paymentClient = getPaymentClient();

  let payment;
  try {
    payment = await paymentClient.get({ id: paymentId });
  } catch (err) {
    console.error(
      `MercadoPago: failed to fetch payment ${paymentId}:`,
      (err as Error).message
    );
    return;
  }

  if (!payment) return;

  const status = payment.status as string | undefined;
  const externalReference = payment.external_reference as string | undefined;

  if (!externalReference) {
    // Subscription payments may not have external_reference; preapproval
    // notification handles activation.
    return;
  }

  // Routing por prefijo: "pkg|..." → credit pack; resto → legacy subscription.
  if (externalReference.startsWith('pkg|')) {
    const parts = externalReference.split('|');
    const purchaseId = parts[1];
    if (!purchaseId) {
      console.error(`MercadoPago: malformed pkg external_reference "${externalReference}"`);
      return;
    }
    await handleCreditPackPayment(purchaseId, paymentId, status);
    return;
  }

  // Legacy: "<tenantId>|<planId>"
  await handleLegacySubscriptionPayment(externalReference, status);
}

/**
 * Acredita un pack de envíos al tenant cuando MP confirma el pago.
 *
 * Idempotencia: el update inicial es condicional a `status: 'PENDING'`. Si
 * el row ya está PAID (webhook duplicado), `updateMany` devuelve count=0 y
 * salimos sin re-acreditar. Esta es la primitiva atómica más sencilla en
 * Prisma sin transacciones interactivas explícitas — la unicidad de
 * mpPaymentId es una segunda red de seguridad por si el primer update se
 * coló a la mitad.
 *
 * Acreditación al referidor: si el tenant que compró tiene referredById,
 * después de marcar PAID:
 *   1. Crear fila ReferralCreditAccrual (sourcePurchaseId @unique evita
 *      doble-acreditación si volvemos a entrar acá).
 *   2. Sumar floor(20% * shipments) a referrer.shipmentCredits.
 *
 * Refunded: status === 'refunded' o 'cancelled' después de PAID → marcamos
 * refundedAt y *intentamos* debitar. Si shipmentCredits ya se gastó en
 * envíos reales, debitamos lo que se pueda y registramos en log. No es
 * perfecto pero es honesto: el tenant ya consumió el servicio.
 */
async function handleCreditPackPayment(
  purchaseId: string,
  paymentId: string,
  status: string | undefined,
) {
  const purchase = await db.creditPurchase.findUnique({
    where: { id: purchaseId },
    select: {
      id: true,
      tenantId: true,
      shipments: true,
      status: true,
      mpPaymentId: true,
    },
  });

  if (!purchase) {
    console.error(`MercadoPago: credit purchase ${purchaseId} not found`);
    return;
  }

  if (status === 'approved') {
    // Idempotente: solo transiciona si está PENDING.
    const updated = await db.creditPurchase.updateMany({
      where: { id: purchaseId, status: 'PENDING' },
      data: {
        status: 'PAID',
        mpPaymentId: paymentId,
        paidAt: new Date(),
      },
    });

    if (updated.count === 0) {
      console.info(
        `MercadoPago: credit purchase ${purchaseId} already processed (idempotent skip)`,
      );
      return;
    }

    // Acreditar envíos al tenant.
    await db.tenant.update({
      where: { id: purchase.tenantId },
      data: {
        shipmentCredits: { increment: purchase.shipments },
        creditsPurchased: { increment: purchase.shipments },
      },
    });

    console.info(
      `MercadoPago: credit pack PAID — tenant=${purchase.tenantId}, shipments=${purchase.shipments}`,
    );

    // Acreditar 20% al referidor (si lo hay).
    await accrueReferralKickback(purchase.tenantId, purchase.id, purchase.shipments);
    return;
  }

  if (status === 'rejected') {
    await db.creditPurchase.updateMany({
      where: { id: purchaseId, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    console.info(`MercadoPago: credit purchase ${purchaseId} rejected`);
    return;
  }

  if (status === 'refunded' || status === 'cancelled' || status === 'charged_back') {
    // Marcamos como REFUNDED y tratamos de debitar lo no gastado.
    const wasUpdated = await db.creditPurchase.updateMany({
      where: { id: purchaseId, status: 'PAID' },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    });
    if (wasUpdated.count === 0) return; // ya estaba refunded o nunca estuvo PAID

    // Debitar el saldo restante (clamp a 0 si ya consumió todo).
    const tenant = await db.tenant.findUnique({
      where: { id: purchase.tenantId },
      select: { shipmentCredits: true },
    });
    if (tenant) {
      const debit = Math.min(tenant.shipmentCredits, purchase.shipments);
      if (debit > 0) {
        await db.tenant.update({
          where: { id: purchase.tenantId },
          data: { shipmentCredits: { decrement: debit } },
        });
      }
      if (debit < purchase.shipments) {
        console.warn(
          `MercadoPago: refund of ${purchase.shipments} shipments but only ${debit} available — ${purchase.shipments - debit} shipments unrecoverable for tenant ${purchase.tenantId}`,
        );
      }
    }
    return;
  }

  // pending / in_process / authorized: nada que hacer hasta approved.
}

/**
 * Crea la acreditación al referidor si el tenant que compró fue referido.
 * Idempotencia: ReferralCreditAccrual.sourcePurchaseId es @unique, así que
 * un segundo intento dispara P2002 — atrapamos y salimos.
 */
async function accrueReferralKickback(
  refereeTenantId: string,
  sourcePurchaseId: string,
  shipmentsPurchased: number,
) {
  const referee = await db.tenant.findUnique({
    where: { id: refereeTenantId },
    select: { referredById: true, userId: true },
  });
  if (!referee?.referredById) return;
  if (referee.referredById === refereeTenantId) return; // tenant-level self-ref

  // self-referral guard a nivel User: si el referrer y el referee comparten
  // el mismo dueño (userId), saltamos. Cubre el caso de un usuario que abre
  // dos tenants y se refiere a sí mismo.
  const referrer = await db.tenant.findUnique({
    where: { id: referee.referredById },
    select: { userId: true },
  });
  if (referrer?.userId && referrer.userId === referee.userId) {
    console.warn(
      `MercadoPago: self-referral detected (userId=${referrer.userId}) — skipping kickback for purchase ${sourcePurchaseId}`,
    );
    return;
  }

  const accrued = calcReferralKickback(shipmentsPurchased);
  if (accrued <= 0) return;

  // Atómico: crear el accrual y acreditar al referrer en la MISMA txn. Si
  // el process crashea entre crear el accrual y actualizar al tenant, el
  // sourcePurchaseId @unique queda bloqueando el retry y el referrer
  // quedaba sin sus créditos. La txn elimina ese hueco TOCTOU.
  try {
    await db.$transaction([
      db.referralCreditAccrual.create({
        data: {
          referrerTenantId: referee.referredById,
          refereeTenantId,
          sourcePurchaseId,
          shipmentsAccrued: accrued,
        },
      }),
      db.tenant.update({
        where: { id: referee.referredById },
        data: {
          shipmentCredits: { increment: accrued },
          referralCreditsEarned: { increment: accrued },
        },
      }),
    ]);
  } catch (err) {
    // P2002 (unique violation) = ya acreditado por un webhook previo —
    // ambas operaciones se rollbackean atómicamente.
    if ((err as { code?: string }).code === 'P2002') {
      console.info(
        `MercadoPago: referral accrual already exists for purchase ${sourcePurchaseId} (idempotent skip)`,
      );
      return;
    }
    throw err;
  }

  console.info(
    `MercadoPago: referral kickback +${accrued} shipments → referrer=${referee.referredById} (referee=${refereeTenantId}, purchase=${sourcePurchaseId})`,
  );
}

/**
 * Handler legacy para suscripciones MercadoPago en formato `<tenantId>|<planId>`.
 * Se mantiene para no romper a tenants pre-existentes en plan recurring.
 * Nuevos tenants no entran por acá.
 */
async function handleLegacySubscriptionPayment(
  externalReference: string,
  status: string | undefined,
) {
  const parts = externalReference.split('|');
  const tenantId = parts[0];
  const planId = parts[1];
  if (!tenantId) return;

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) return;

  if (status === 'approved') {
    const currentPeriodEnd = new Date();
    currentPeriodEnd.setDate(currentPeriodEnd.getDate() + 30);

    await db.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionStatus: 'ACTIVE',
        isActive: true,
        stripePriceId: planId ?? undefined,
        currentPeriodEnd,
        labelsThisMonth: 0,
      },
    });

    console.info(
      `MercadoPago [legacy]: recurring payment approved for ${tenantId}, period extended`,
    );
  } else if (status === 'rejected') {
    await db.tenant.update({
      where: { id: tenantId },
      data: { subscriptionStatus: 'PAST_DUE' },
    });
    console.info(`MercadoPago [legacy]: recurring payment rejected for ${tenantId}`);
  }
}

/**
 * MercadoPago may also send GET requests to verify the webhook URL is accessible.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}
