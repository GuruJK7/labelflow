import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { decrypt } from '@/lib/encryption'
import { normalizePhone, buildCheckoutUrl, maskPhone } from '@/lib/recover-utils'
import type { CartItem } from '@/types/recover'

function verifyHmac(body: string, hmacHeader: string, secret: string): boolean {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64')
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmacHeader, 'base64'),
      Buffer.from(digest, 'base64')
    )
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  const hmacHeader = req.headers.get('x-shopify-hmac-sha256')
  const topic = req.headers.get('x-shopify-topic')
  const shopDomain = req.headers.get('x-shopify-shop-domain')

  if (!hmacHeader || !topic || !shopDomain) {
    return NextResponse.json({ error: 'Missing headers' }, { status: 401 })
  }

  // Only process checkout events
  if (!['checkouts/create', 'checkouts/update'].includes(topic)) {
    return NextResponse.json({ ok: true })
  }

  // Find tenant with active recover module
  const tenant = await db.tenant.findFirst({
    where: {
      shopifyStoreUrl: shopDomain,
      isActive: true,
    },
    select: {
      id: true,
      shopifyToken: true,
      shopifyStoreUrl: true,
      recoverConfig: {
        select: {
          id: true,
          isActive: true,
          subscriptionStatus: true,
          delayMinutes: true,
          secondMessageEnabled: true,
          secondMessageDelayMinutes: true,
          messageTemplate2: true,
        },
      },
    },
  })

  if (!tenant || !tenant.shopifyToken) {
    return NextResponse.json({ ok: true })
  }

  // Verify HMAC
  const shopifySecret = decrypt(tenant.shopifyToken)
  if (!verifyHmac(body, hmacHeader, shopifySecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Recover module must be active with valid subscription
  const config = tenant.recoverConfig
  if (!config || !config.isActive || config.subscriptionStatus !== 'ACTIVE') {
    return NextResponse.json({ ok: true })
  }

  const checkout = JSON.parse(body)

  try {
    await processCheckout(checkout, tenant, config, shopDomain)
  } catch (err) {
    console.error('[Recover Webhook] Error processing checkout:', err instanceof Error ? err.message : err)
  }

  return NextResponse.json({ ok: true })
}

interface TenantWithConfig {
  id: string
  shopifyStoreUrl: string | null
}

interface RecoverConfigSlice {
  id: string
  delayMinutes: number
  secondMessageEnabled: boolean
  secondMessageDelayMinutes: number
  messageTemplate2: string | null
}

async function processCheckout(
  checkout: Record<string, unknown>,
  tenant: TenantWithConfig,
  config: RecoverConfigSlice,
  shopDomain: string
): Promise<void> {
  const checkoutId = String(checkout.id)
  const checkoutToken = String(checkout.token ?? '')

  // If checkout was completed, mark as recovered and cancel pending jobs
  if (checkout.completed_at) {
    const existingCart = await db.recoverCart.findUnique({
      where: {
        tenantId_shopifyCheckoutId: {
          tenantId: tenant.id,
          shopifyCheckoutId: checkoutId,
        },
      },
      select: { id: true },
    })

    if (existingCart) {
      // Cancel any pending recover jobs for this cart
      await db.recoverJob.updateMany({
        where: {
          cartId: existingCart.id,
          status: 'PENDING',
        },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
        },
      })

      await db.recoverCart.update({
        where: { id: existingCart.id },
        data: {
          status: 'RECOVERED',
          recoveredAt: new Date(checkout.completed_at as string),
          recoveredOrderId: checkout.order_id ? String(checkout.order_id) : null,
        },
      })
    }

    return
  }

  // Extract customer data from checkout
  const shippingAddress = checkout.shipping_address as Record<string, unknown> | null
  const billingAddress = checkout.billing_address as Record<string, unknown> | null

  const phone = normalizePhone(
    (shippingAddress?.phone as string) ??
    (checkout.phone as string) ??
    (billingAddress?.phone as string)
  )

  const lineItems = (checkout.line_items ?? []) as Array<Record<string, unknown>>
  const cartItems: CartItem[] = lineItems.map((item) => ({
    title: String(item.title ?? ''),
    quantity: Number(item.quantity ?? 1),
    price: parseFloat(String(item.price ?? '0')),
    image_url: (item.image_url as string) ?? undefined,
  }))

  const cartTotal = parseFloat(String(checkout.total_price ?? '0'))
  const checkoutUrl = buildCheckoutUrl(shopDomain, checkoutToken)

  const customerName = [
    shippingAddress?.first_name,
    shippingAddress?.last_name,
  ]
    .filter(Boolean)
    .join(' ') || (checkout.email as string)?.split('@')[0] || null

  // Upsert the abandoned cart
  const cart = await db.recoverCart.upsert({
    where: {
      tenantId_shopifyCheckoutId: {
        tenantId: tenant.id,
        shopifyCheckoutId: checkoutId,
      },
    },
    create: {
      tenantId: tenant.id,
      shopifyCheckoutId: checkoutId,
      shopifyCheckoutToken: checkoutToken,
      customerPhone: phone,
      customerName: customerName,
      customerEmail: (checkout.email as string) ?? null,
      cartTotal,
      currency: (checkout.currency as string) ?? 'UYU',
      cartItems: JSON.parse(JSON.stringify(cartItems)),
      checkoutUrl,
      status: phone ? 'PENDING' : 'NO_PHONE',
      recoverConfigId: config.id,
    },
    update: {
      customerPhone: phone,
      customerName: customerName,
      customerEmail: (checkout.email as string) ?? null,
      cartTotal,
      cartItems: JSON.parse(JSON.stringify(cartItems)),
      checkoutUrl,
    },
  })

  // If the cart previously had NO_PHONE and now has a phone, promote it to PENDING
  // so that job scheduling proceeds below. Never downgrade terminal statuses.
  const terminalStatuses = ['RECOVERED', 'OPTED_OUT', 'MESSAGE_2_SENT']
  if (phone && cart.status === 'NO_PHONE') {
    await db.recoverCart.update({
      where: { id: cart.id },
      data: { status: 'PENDING' },
    })
    cart.status = 'PENDING'
  } else if (!phone && cart.status === 'PENDING') {
    await db.recoverCart.update({
      where: { id: cart.id },
      data: { status: 'NO_PHONE' },
    })
  }

  // Only schedule messages for carts that are now PENDING with a phone number
  if (cart.status !== 'PENDING' || !phone || terminalStatuses.includes(cart.status)) {
    return
  }

  // Check if jobs already exist for this cart
  const existingJobs = await db.recoverJob.count({
    where: { cartId: cart.id },
  })

  if (existingJobs > 0) {
    return
  }

  // Schedule message 1
  const delay1Ms = config.delayMinutes * 60 * 1000
  const scheduledFor1 = new Date(Date.now() + delay1Ms)

  await db.recoverJob.create({
    data: {
      tenantId: tenant.id,
      cartId: cart.id,
      messageNumber: 1,
      scheduledFor: scheduledFor1,
    },
  })

  // Schedule message 2 if enabled
  if (config.secondMessageEnabled && config.messageTemplate2) {
    const delay2Ms = (config.delayMinutes + config.secondMessageDelayMinutes) * 60 * 1000
    const scheduledFor2 = new Date(Date.now() + delay2Ms)

    await db.recoverJob.create({
      data: {
        tenantId: tenant.id,
        cartId: cart.id,
        messageNumber: 2,
        scheduledFor: scheduledFor2,
      },
    })
  }

  console.warn(`[Recover] Scheduled recovery for cart ${cart.id}, phone ${maskPhone(phone)}`)
}
