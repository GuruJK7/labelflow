import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';

const PRICE_MAP: Record<string, string | undefined> = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth: process.env.STRIPE_PRICE_GROWTH,
  pro: process.env.STRIPE_PRICE_PRO,
};

export async function GET(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const plan = req.nextUrl.searchParams.get('plan');
  if (!plan || !PRICE_MAP[plan]) {
    return apiError('Plan invalido. Opciones: starter, growth, pro', 400);
  }

  const priceId = PRICE_MAP[plan];
  if (!priceId) {
    return apiError('Price ID no configurado para este plan', 500);
  }

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { stripeCustomerId: true, userId: true },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  const user = await db.user.findUnique({
    where: { id: tenant.userId },
    select: { email: true },
  });

  // Create or get Stripe customer
  let customerId = tenant.stripeCustomerId;
  if (!customerId) {
    const customer = await getStripe().customers.create({
      email: user?.email ?? undefined,
      metadata: { tenantId: auth.tenantId },
    });
    customerId = customer.id;
    await db.tenant.update({
      where: { id: auth.tenantId },
      data: { stripeCustomerId: customerId },
    });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/settings/billing?success=true`,
    cancel_url: `${appUrl}/settings/billing`,
    metadata: { tenantId: auth.tenantId },
  });

  return NextResponse.redirect(session.url ?? `${appUrl}/settings/billing`);
}
