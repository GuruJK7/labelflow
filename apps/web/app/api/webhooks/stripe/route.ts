import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { db } from '@/lib/db';
import type Stripe from 'stripe';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
  }

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET ?? ''
    );
  } catch (err) {
    console.error('Stripe webhook signature error:', (err as Error).message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.customer && session.subscription) {
          const sub = await getStripe().subscriptions.retrieve(session.subscription as string);
          await db.tenant.update({
            where: { stripeCustomerId: session.customer as string },
            data: {
              stripeSubscriptionId: sub.id,
              stripePriceId: sub.items.data[0]?.price.id,
              subscriptionStatus: 'ACTIVE',
              isActive: true,
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
          });
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.customer && invoice.subscription) {
          const sub = await getStripe().subscriptions.retrieve(invoice.subscription as string);
          await db.tenant.update({
            where: { stripeCustomerId: invoice.customer as string },
            data: {
              subscriptionStatus: 'ACTIVE',
              isActive: true,
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              labelsThisMonth: 0, // Reset monthly counter
            },
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.customer) {
          await db.tenant.updateMany({
            where: { stripeCustomerId: invoice.customer as string },
            data: { subscriptionStatus: 'PAST_DUE' },
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        if (sub.customer) {
          await db.tenant.updateMany({
            where: { stripeCustomerId: sub.customer as string },
            data: {
              subscriptionStatus: 'CANCELED',
              isActive: false,
            },
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        if (sub.customer) {
          const statusMap: Record<string, string> = {
            active: 'ACTIVE',
            past_due: 'PAST_DUE',
            canceled: 'CANCELED',
            trialing: 'TRIALING',
            paused: 'PAUSED',
          };
          const mappedStatus = statusMap[sub.status] ?? 'INACTIVE';
          const isActive = sub.status === 'active' || sub.status === 'trialing';
          await db.tenant.updateMany({
            where: { stripeCustomerId: sub.customer as string },
            data: {
              stripePriceId: sub.items.data[0]?.price.id,
              subscriptionStatus: mappedStatus as 'ACTIVE',
              isActive,
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Stripe webhook handler error:', (err as Error).message);
  }

  return NextResponse.json({ received: true });
}
