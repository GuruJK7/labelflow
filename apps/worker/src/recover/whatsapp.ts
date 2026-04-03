/**
 * WhatsApp Cloud API client for the worker process.
 * Uses Meta Graph API v19.0 with native fetch — no external dependencies.
 *
 * Supports dual-mode:
 *   PLATFORM — uses AutoEnvia's shared credentials from env vars
 *   OWN      — uses per-tenant credentials passed explicitly
 */

const WHATSAPP_API_VERSION = 'v19.0';

export interface WhatsAppCredentials {
  apiToken: string;
  phoneNumberId: string;
}

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: { code: string; message: string };
}

/**
 * Sends a text message via WhatsApp Cloud API.
 *
 * @param to           Recipient phone in E.164 format (+598XXXXXXXX)
 * @param body         Message text (already interpolated)
 * @param credentials  Optional per-tenant credentials (OWN mode).
 *                     Falls back to env vars (PLATFORM mode) when omitted.
 */
export async function sendWhatsAppMessage({
  to,
  body,
  credentials,
}: {
  to: string;
  body: string;
  credentials?: WhatsAppCredentials;
}): Promise<SendResult> {
  // Resolve credentials: explicit (OWN) > env vars (PLATFORM)
  const phoneNumberId = credentials?.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = credentials?.apiToken ?? process.env.WHATSAPP_API_TOKEN;

  if (!phoneNumberId || !token) {
    return {
      success: false,
      error: {
        code: 'CONFIG_MISSING',
        message: credentials
          ? 'Tenant WhatsApp credentials incomplete'
          : 'Platform WhatsApp credentials not configured (WHATSAPP_API_TOKEN / WHATSAPP_PHONE_NUMBER_ID)',
      },
    };
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: true, body },
      }),
    });

    const data = (await res.json()) as {
      messages?: Array<{ id: string }>;
      error?: { code: number; message: string };
    };

    if (!res.ok) {
      return {
        success: false,
        error: {
          code: data.error?.code?.toString() ?? res.status.toString(),
          message: data.error?.message ?? 'Unknown Meta API error',
        },
      };
    }

    return {
      success: true,
      messageId: data.messages?.[0]?.id ?? undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Network error';
    return {
      success: false,
      error: { code: 'NETWORK_ERROR', message },
    };
  }
}
