/**
 * Recover module setup utilities.
 * Handles Shopify webhook registration when a tenant activates the Recover module.
 */

import { db } from '@/lib/db';
import { decrypt } from '@/lib/encryption';

const SHOPIFY_API_VERSION = '2024-01';
const CHECKOUT_TOPICS = ['checkouts/create', 'checkouts/update'] as const;

/**
 * Registers Shopify checkout webhooks for a tenant.
 * Call this when a tenant activates the Recover module.
 * Idempotent — Shopify returns 422 if the webhook already exists, which we ignore.
 *
 * @returns true if all webhooks were registered successfully (or already existed)
 */
export async function registerShopifyRecoverWebhooks(tenantId: string): Promise<boolean> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant.shopifyToken) {
    console.warn(`[Recover Setup] Tenant ${tenantId} missing Shopify credentials`);
    return false;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    console.warn('[Recover Setup] NEXT_PUBLIC_APP_URL not set');
    return false;
  }

  let accessToken: string;
  try {
    accessToken = decrypt(tenant.shopifyToken);
  } catch {
    console.warn(`[Recover Setup] Failed to decrypt Shopify token for tenant ${tenantId}`);
    return false;
  }

  const webhookUrl = `${appUrl}/api/webhooks/shopify/checkouts`;
  let allSucceeded = true;

  for (const topic of CHECKOUT_TOPICS) {
    try {
      const res = await fetch(
        `https://${tenant.shopifyStoreUrl}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            webhook: {
              topic,
              address: webhookUrl,
              format: 'json',
            },
          }),
        }
      );

      if (!res.ok && res.status !== 422) {
        const err = await res.json();
        console.warn(
          `[Recover Setup] Failed to register webhook ${topic} for tenant ${tenantId}:`,
          err
        );
        allSucceeded = false;
      } else {
        console.warn(`[Recover Setup] Webhook ${topic} registered for tenant ${tenantId}`);
      }
    } catch (err) {
      console.warn(
        `[Recover Setup] Network error registering webhook ${topic}:`,
        (err as Error).message
      );
      allSucceeded = false;
    }
  }

  return allSucceeded;
}

/**
 * Deregisters Shopify checkout webhooks for a tenant.
 * Call this when a tenant cancels the Recover subscription.
 */
export async function unregisterShopifyRecoverWebhooks(tenantId: string): Promise<void> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { shopifyStoreUrl: true, shopifyToken: true },
  });

  if (!tenant?.shopifyStoreUrl || !tenant.shopifyToken) return;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return;

  let accessToken: string;
  try {
    accessToken = decrypt(tenant.shopifyToken);
  } catch {
    return;
  }

  const webhookUrl = `${appUrl}/api/webhooks/shopify/checkouts`;

  try {
    // List current webhooks
    const listRes = await fetch(
      `https://${tenant.shopifyStoreUrl}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
      }
    );

    if (!listRes.ok) return;

    const data = await listRes.json() as { webhooks: Array<{ id: number; address: string }> };
    const toDelete = data.webhooks.filter((wh) => wh.address === webhookUrl);

    for (const wh of toDelete) {
      await fetch(
        `https://${tenant.shopifyStoreUrl}/admin/api/${SHOPIFY_API_VERSION}/webhooks/${wh.id}.json`,
        {
          method: 'DELETE',
          headers: { 'X-Shopify-Access-Token': accessToken },
        }
      ).catch(() => {});
    }
  } catch {
    // Non-fatal
  }
}
