import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { encrypt, encryptIfPresent } from '@/lib/encryption';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

const updateSchema = z.object({
  isActive: z.boolean().optional(),
  delayMinutes: z.number().int().min(15).max(1440).optional(),
  secondMessageEnabled: z.boolean().optional(),
  secondMessageDelayMinutes: z.number().int().min(60).max(10080).optional(),
  messageTemplate1: z.string().min(10).max(1000).optional(),
  messageTemplate2: z.string().min(10).max(1000).optional(),
  optOutKeyword: z.string().min(2).max(20).optional(),
  // WhatsApp credentials (dual-mode)
  whatsappMode: z.enum(['PLATFORM', 'OWN']).optional(),
  whatsappApiToken: z.string().min(10).max(500).optional(), // raw — encrypted before storing
  whatsappPhoneNumberId: z.string().min(5).max(30).optional(),
});

// GET /api/recover/config — returns or creates config for current tenant
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let config = await db.recoverConfig.findUnique({
    where: { tenantId: auth.tenantId },
  });

  // Auto-create on first access
  if (!config) {
    config = await db.recoverConfig.create({
      data: { tenantId: auth.tenantId },
    });
  }

  // Never expose the raw API token — return a boolean flag instead
  return apiSuccess({
    ...config,
    whatsappApiToken: undefined,
    whatsappApiTokenSet: !!config.whatsappApiToken,
  });
}

// PUT /api/recover/config — update tenant recover config
export async function PUT(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0]?.message ?? 'Datos invalidos', 400);
  }

  // Ensure config exists
  const existing = await db.recoverConfig.findUnique({
    where: { tenantId: auth.tenantId },
  });

  // Separate the raw whatsappApiToken before passing to Prisma — it needs encryption
  const { whatsappApiToken: rawToken, ...restData } = parsed.data;

  // Build the final data payload, encrypting the API token if provided
  const dataToSave: Record<string, unknown> = { ...restData };
  if (rawToken !== undefined) {
    dataToSave.whatsappApiToken = encrypt(rawToken);
  }

  let config;
  if (!existing) {
    config = await db.recoverConfig.create({
      data: { tenantId: auth.tenantId, ...dataToSave },
    });
  } else {
    config = await db.recoverConfig.update({
      where: { tenantId: auth.tenantId },
      data: dataToSave,
    });
  }

  return apiSuccess({
    ...config,
    whatsappApiToken: undefined,
    whatsappApiTokenSet: !!config.whatsappApiToken,
  });
}
