/**
 * WhatsApp Cloud API client.
 * Uses Meta Graph API v19.0 with native fetch (no external dependencies).
 */

const WHATSAPP_API_VERSION = 'v19.0'

interface SendResult {
  success: boolean
  messageId?: string
  error?: { code: string; message: string }
}

/**
 * Sends a text message via WhatsApp Cloud API.
 * Returns the message ID on success, or error details on failure.
 */
export async function sendWhatsAppMessage({
  to,
  body,
}: {
  to: string
  body: string
}): Promise<SendResult> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_API_TOKEN

  if (!phoneNumberId || !token) {
    return {
      success: false,
      error: { code: 'CONFIG_MISSING', message: 'WhatsApp API credentials not configured' },
    }
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`

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
    })

    const data = await res.json()

    if (!res.ok) {
      return {
        success: false,
        error: {
          code: data.error?.code?.toString() ?? res.status.toString(),
          message: data.error?.message ?? 'Unknown Meta API error',
        },
      }
    }

    return {
      success: true,
      messageId: data.messages?.[0]?.id ?? undefined,
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Network error'
    return {
      success: false,
      error: { code: 'NETWORK_ERROR', message },
    }
  }
}
