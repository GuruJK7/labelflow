import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { decryptIfPresent } from '@/lib/encryption';
import { normalizePhone } from '@/lib/recover-utils';

/**
 * POST /api/recover/sync
 * Fetches abandoned checkouts from Shopify and upserts them into RecoverCart.
 */
export async function POST(_req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Get tenant with Shopify credentials
  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant?.shopifyToken) {
    return apiError('Shopify no configurado. Ve a Configuracion para conectar tu tienda.', 400);
  }

  const token = decryptIfPresent(tenant.shopifyToken);
  if (!token) return apiError('Token de Shopify invalido', 400);

  // Ensure RecoverConfig exists for this tenant
  let recoverConfig = await db.recoverConfig.findUnique({
    where: { tenantId: auth.tenantId },
  });
  if (!recoverConfig) {
    recoverConfig = await db.recoverConfig.create({
      data: { tenantId: auth.tenantId },
    });
  }

  try {
    // Fetch abandoned checkouts from Shopify (last 30 days)
    const since = new Date();
    since.setDate(since.getDate() - 30);

    let allCheckouts: ShopifyCheckout[] = [];
    let url = `https://${tenant.shopifyStoreUrl}/admin/api/2024-01/checkouts.json?limit=250&created_at_min=${since.toISOString()}&status=open`;

    // Paginate through all results
    while (url) {
      const res = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        // Loguear server-side, no leak Shopify internals al cliente.
        console.error(`[recover/sync] Shopify API ${res.status}: ${errText.slice(0, 500)}`);
        return apiError('Error conectando con Shopify', 502);
      }

      const data = await res.json();
      const checkouts: ShopifyCheckout[] = data.checkouts || [];
      allCheckouts = allCheckouts.concat(checkouts);

      // Follow pagination via Link header — restringido al origin de la
      // tienda para prevenir SSRF si el header viene manipulado.
      const linkHeader = res.headers.get('link');
      url = parsePaginationNext(linkHeader, `https://${tenant.shopifyStoreUrl}`);
    }

    // Filter: only abandoned (no completed_at) and with some contact info
    const abandoned = allCheckouts.filter(
      (c) => !c.completed_at && (c.phone || c.email || c.shipping_address?.phone || c.billing_address?.phone)
    );

    // Upsert each abandoned checkout
    let created = 0;
    let updated = 0;
    for (const checkout of abandoned) {
      const phone = normalizePhone(
        checkout.phone ||
        checkout.shipping_address?.phone ||
        checkout.billing_address?.phone ||
        null
      );
      const name = checkout.shipping_address
        ? `${checkout.shipping_address.first_name || ''} ${checkout.shipping_address.last_name || ''}`.trim()
        : checkout.billing_address
          ? `${checkout.billing_address.first_name || ''} ${checkout.billing_address.last_name || ''}`.trim()
          : null;

      const cartItems = (checkout.line_items || []).map((item) => ({
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        variant: item.variant_title || null,
        sku: item.sku || null,
      }));

      const existing = await db.recoverCart.findUnique({
        where: {
          tenantId_shopifyCheckoutId: {
            tenantId: auth.tenantId,
            shopifyCheckoutId: String(checkout.id),
          },
        },
      });

      if (existing) {
        // Only update if not in terminal status
        if (!['RECOVERED', 'OPTED_OUT'].includes(existing.status)) {
          await db.recoverCart.update({
            where: { id: existing.id },
            data: {
              customerPhone: phone,
              customerName: name,
              customerEmail: checkout.email || null,
              cartTotal: parseFloat(checkout.total_price || '0'),
              currency: checkout.presentment_currency || checkout.currency || 'UYU',
              cartItems: JSON.stringify(cartItems),
              checkoutUrl: checkout.abandoned_checkout_url || null,
            },
          });
          updated++;
        }
      } else {
        await db.recoverCart.create({
          data: {
            tenantId: auth.tenantId,
            recoverConfigId: recoverConfig.id,
            shopifyCheckoutId: String(checkout.id),
            shopifyCheckoutToken: checkout.token || '',
            customerPhone: phone,
            customerName: name,
            customerEmail: checkout.email || null,
            cartTotal: parseFloat(checkout.total_price || '0'),
            currency: checkout.presentment_currency || checkout.currency || 'UYU',
            cartItems: JSON.stringify(cartItems),
            checkoutUrl: checkout.abandoned_checkout_url || null,
            status: phone ? 'PENDING' : 'NO_PHONE',
          },
        });
        created++;
      }
    }

    return apiSuccess({
      synced: abandoned.length,
      created,
      updated,
      totalFromShopify: allCheckouts.length,
    });
  } catch (err) {
    return apiError(`Error sincronizando: ${(err as Error).message}`, 500);
  }
}

// ── Types ──

interface ShopifyCheckout {
  id: number;
  token: string;
  email: string | null;
  phone: string | null;
  total_price: string;
  subtotal_price: string;
  currency: string;
  presentment_currency: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  abandoned_checkout_url: string;
  line_items: Array<{
    title: string;
    quantity: number;
    price: string;
    variant_title: string | null;
    sku: string | null;
  }>;
  shipping_address: {
    first_name: string;
    last_name: string;
    phone: string | null;
  } | null;
  billing_address: {
    first_name: string;
    last_name: string;
    phone: string | null;
  } | null;
}

// ── Helpers ──

/**
 * Extrae la URL `rel="next"` del header Link de Shopify, validando que
 * apunte al MISMO origin de la tienda. Sin este check, una respuesta
 * maliciosa podría redirigir nuestro fetch outbound a IMDS interno (SSRF).
 */
function parsePaginationNext(linkHeader: string | null, baseUrl: string): string {
  if (!linkHeader) return '';
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (!match) continue;
    const candidate = match[1];
    if (!candidate.startsWith(`${baseUrl}/`)) {
      console.warn(
        `[recover/sync] dropping next URL outside baseUrl: ${candidate}`,
      );
      return '';
    }
    return candidate;
  }
  return '';
}

// normalizePhone imported from @/lib/recover-utils (single source of truth)
