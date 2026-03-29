/**
 * Notification service for Meta Ads Agent events.
 * Sends webhook notifications from the web app.
 * Email notifications are handled by the worker (which has nodemailer).
 */

interface NotificationPayload {
  event: 'ad_uploaded' | 'ad_paused_auto' | 'ad_error' | 'scan_completed' | 'monitor_alert';
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

interface NotificationConfig {
  webhook?: string | null;
}

/**
 * Send notification via webhook.
 */
export async function sendNotification(
  config: NotificationConfig,
  payload: NotificationPayload
): Promise<{ webhookSent: boolean }> {
  let webhookSent = false;

  if (config.webhook) {
    try {
      const res = await fetch(config.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: payload.event,
          title: payload.title,
          message: payload.message,
          metadata: payload.metadata,
          timestamp: new Date().toISOString(),
        }),
      });
      webhookSent = res.ok;
    } catch {
      webhookSent = false;
    }
  }

  return { webhookSent };
}

/**
 * Build notification config from ad account data.
 */
export function buildNotificationConfig(
  adAccount: {
    notifyWebhook?: string | null;
  }
): NotificationConfig {
  return {
    webhook: adAccount.notifyWebhook,
  };
}
