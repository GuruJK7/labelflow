import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { decrypt } from '@/lib/encryption';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

const WHATSAPP_API_VERSION = 'v19.0';

const testSchema = z.object({
  to: z.string().min(8).max(20), // phone number in E.164
});

/**
 * POST /api/recover/test-whatsapp
 * Sends a test WhatsApp message using the tenant's configured credentials
 * (either PLATFORM env vars or their own OWN credentials).
 * Used from the settings page to verify the connection works.
 */
export async function POST(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const body = await req.json();
  const parsed = testSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0]?.message ?? 'Numero invalido', 400);
  }

  const config = await db.recoverConfig.findUnique({
    where: { tenantId: auth.tenantId },
  });

  if (!config) return apiError('Configuracion no encontrada', 404);

  // Resolve credentials based on mode
  let apiToken: string | undefined;
  let phoneNumberId: string | undefined;

  if (config.whatsappMode === 'OWN') {
    if (!config.whatsappApiToken || !config.whatsappPhoneNumberId) {
      return apiError('Debes configurar tu API Token y Phone Number ID primero', 400);
    }
    try {
      apiToken = decrypt(config.whatsappApiToken);
    } catch {
      return apiError('Error al descifrar credenciales — vuelve a guardar el token', 500);
    }
    phoneNumberId = config.whatsappPhoneNumberId;
  } else {
    // PLATFORM mode — use AutoEnvia's env vars
    apiToken = process.env.WHATSAPP_API_TOKEN;
    phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!apiToken || !phoneNumberId) {
      return apiError('El numero de AutoEnvia no esta configurado aun. Contacta al soporte.', 503);
    }
  }

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`;
  const testBody = `✅ Mensaje de prueba de AutoEnvia Recover. Tu conexion de WhatsApp esta funcionando correctamente.`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: parsed.data.to,
        type: 'text',
        text: { body: testBody },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return apiError(
        `Error de Meta API: ${data.error?.message ?? 'Error desconocido'} (codigo ${data.error?.code ?? res.status})`,
        400
      );
    }

    return apiSuccess({ messageId: data.messages?.[0]?.id });
  } catch (err) {
    return apiError(`Error de red: ${(err as Error).message}`, 500);
  }
}
