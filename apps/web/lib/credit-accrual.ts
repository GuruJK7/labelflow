import { db } from '@/lib/db';
import { calcReferralKickback } from '@/lib/credit-packs';
import { trackServer } from '@/lib/analytics.server';
import { getCreditHolderTenantId } from '@/lib/credit-holder';

/**
 * Acreditación de packs de envíos — la MISMA función para todos los rieles
 * de pago (D34). Extraída del webhook de MercadoPago sin cambiar semántica:
 * MercadoPago y Whop la llaman con su propio `rail` y su propio id de pago.
 *
 * Idempotencia (dos redes):
 *   1. `updateMany({ id, status: 'PENDING' })` → count 0 = ya procesada.
 *   2. `CreditPurchase.mpPaymentId @unique` → si otro purchase ya tiene ese
 *      id de pago, Prisma tira P2002 y NO se acredita (`duplicate_payment`).
 *      Whop guarda `whop:<pay_id>` en esa misma columna.
 *
 * Multi-tienda: el saldo vive en el tenant HOLDER del usuario (el más viejo),
 * así que se acredita ahí aunque la compra se haya hecho desde otra tienda.
 *
 * Logs: sólo ids y cantidades, con prefijo `[<rail>]`. Nunca el cuerpo del
 * webhook ni datos del pagador.
 */

export type PaymentRail = 'mercadopago' | 'whop';

export interface SettleInput {
  purchaseId: string;
  /** Id del pago en el riel. Whop: `whop:<pay_id>`. MP: el id numérico. */
  externalPaymentId: string;
  rail: PaymentRail;
}

export type SettleResult =
  | { credited: true; holderTenantId: string; shipments: number; firstPaidPack: boolean }
  | { credited: false; reason: 'not_found' | 'already_processed' | 'duplicate_payment' };

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** PENDING → PAID + acreditación al holder + evento de primer pack + kickback. */
export async function settlePaidPurchase(input: SettleInput): Promise<SettleResult> {
  const { purchaseId, externalPaymentId, rail } = input;
  const purchase = await db.creditPurchase.findUnique({
    where: { id: purchaseId },
    select: {
      id: true,
      tenantId: true,
      packId: true,
      shipments: true,
      totalPriceUyu: true,
      status: true,
    },
  });

  if (!purchase) {
    console.error(`[${rail}] credit purchase ${purchaseId} not found`);
    return { credited: false, reason: 'not_found' };
  }

  // Se lee ANTES de la transición: sólo la llamada que mueve PENDING → PAID
  // ve el conteo previo, así el evento de "primer pack" se dispara una vez.
  const priorPaidCount = await db.creditPurchase.count({
    where: {
      tenantId: purchase.tenantId,
      status: 'PAID',
      id: { not: purchase.id },
    },
  });

  let updated: { count: number };
  try {
    updated = await db.creditPurchase.updateMany({
      where: { id: purchaseId, status: 'PENDING' },
      data: {
        status: 'PAID',
        mpPaymentId: externalPaymentId,
        paidAt: new Date(),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.warn(
        `[${rail}] payment ${externalPaymentId} already attached to another purchase — not crediting ${purchaseId}`,
      );
      return { credited: false, reason: 'duplicate_payment' };
    }
    throw err;
  }

  if (updated.count === 0) {
    console.info(`[${rail}] credit purchase ${purchaseId} already processed (idempotent skip)`);
    return { credited: false, reason: 'already_processed' };
  }

  const holderTenantId = await getCreditHolderTenantId(purchase.tenantId);
  await db.tenant.update({
    where: { id: holderTenantId },
    data: {
      shipmentCredits: { increment: purchase.shipments },
      creditsPurchased: { increment: purchase.shipments },
    },
  });

  console.info(
    `[${rail}] credit pack PAID — purchase=${purchase.id} purchaseTenant=${purchase.tenantId} holderTenant=${holderTenantId} shipments=${purchase.shipments}`,
  );

  const firstPaidPack = priorPaidCount === 0;
  if (firstPaidPack) {
    await trackServer(purchase.tenantId, 'subscription_activated', {
      plan: purchase.packId,
      amount_uyu: purchase.totalPriceUyu,
      rail,
    });
  }

  await accrueReferralKickback(purchase.tenantId, purchase.id, purchase.shipments, rail);

  return { credited: true, holderTenantId, shipments: purchase.shipments, firstPaidPack };
}

/** PENDING → FAILED. Si ya no está PENDING, no hace nada. */
export async function failPendingPurchase(purchaseId: string, rail: PaymentRail): Promise<void> {
  await db.creditPurchase.updateMany({
    where: { id: purchaseId, status: 'PENDING' },
    data: { status: 'FAILED' },
  });
  console.info(`[${rail}] credit purchase ${purchaseId} rejected`);
}

/**
 * PAID → REFUNDED e intento de débito al holder, con clamp al saldo: si el
 * tenant ya gastó los envíos, se debita lo que queda y se deja constancia.
 */
export async function refundPaidPurchase(
  purchaseId: string,
  rail: PaymentRail,
): Promise<{ refunded: boolean; debited: number }> {
  const purchase = await db.creditPurchase.findUnique({
    where: { id: purchaseId },
    select: { id: true, tenantId: true, shipments: true },
  });
  if (!purchase) {
    console.error(`[${rail}] credit purchase ${purchaseId} not found (refund)`);
    return { refunded: false, debited: 0 };
  }

  const wasUpdated = await db.creditPurchase.updateMany({
    where: { id: purchaseId, status: 'PAID' },
    data: { status: 'REFUNDED', refundedAt: new Date() },
  });
  if (wasUpdated.count === 0) return { refunded: false, debited: 0 };

  const holderTenantId = await getCreditHolderTenantId(purchase.tenantId);
  const holder = await db.tenant.findUnique({
    where: { id: holderTenantId },
    select: { shipmentCredits: true },
  });
  let debit = 0;
  if (holder) {
    debit = Math.min(holder.shipmentCredits, purchase.shipments);
    if (debit > 0) {
      await db.tenant.update({
        where: { id: holderTenantId },
        data: { shipmentCredits: { decrement: debit } },
      });
    }
    if (debit < purchase.shipments) {
      console.warn(
        `[${rail}] refund of ${purchase.shipments} shipments but only ${debit} available on holder ${holderTenantId} — ${purchase.shipments - debit} shipments unrecoverable for purchase tenant ${purchase.tenantId}`,
      );
    }
  }
  return { refunded: true, debited: debit };
}

/**
 * Acredita el 20% al referidor si el tenant que compró fue referido.
 * Idempotencia: `ReferralCreditAccrual.sourcePurchaseId @unique`; el segundo
 * intento dispara P2002 y se sale sin error. Todo en una transacción para que
 * no quede el accrual creado sin el saldo (TOCTOU).
 */
export async function accrueReferralKickback(
  refereeTenantId: string,
  sourcePurchaseId: string,
  shipmentsPurchased: number,
  rail: PaymentRail = 'mercadopago',
): Promise<void> {
  const referee = await db.tenant.findUnique({
    where: { id: refereeTenantId },
    select: { referredById: true, userId: true },
  });
  if (!referee?.referredById) return;
  if (referee.referredById === refereeTenantId) return;

  const referrer = await db.tenant.findUnique({
    where: { id: referee.referredById },
    select: { userId: true },
  });
  if (referrer?.userId && referrer.userId === referee.userId) {
    console.warn(
      `[${rail}] self-referral detected (userId=${referrer.userId}) — skipping kickback for purchase ${sourcePurchaseId}`,
    );
    return;
  }

  const accrued = calcReferralKickback(shipmentsPurchased);
  if (accrued <= 0) return;

  const referrerHolderId = await getCreditHolderTenantId(referee.referredById);
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
        where: { id: referrerHolderId },
        data: {
          shipmentCredits: { increment: accrued },
          referralCreditsEarned: { increment: accrued },
        },
      }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.info(
        `[${rail}] referral accrual already exists for purchase ${sourcePurchaseId} (idempotent skip)`,
      );
      return;
    }
    throw err;
  }

  console.info(
    `[${rail}] referral kickback +${accrued} shipments → referrer=${referee.referredById} (referee=${refereeTenantId}, purchase=${sourcePurchaseId})`,
  );
}
