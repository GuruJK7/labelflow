import { z } from 'zod';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { encrypt } from '@/lib/encryption';

/**
 * GET /api/ads/config — Get Meta Ad Account config for the authenticated tenant.
 */
export async function GET() {
  const session = await getAuthenticatedTenant();
  if (!session) return apiError('Unauthorized', 401);

  const adAccount = await db.metaAdAccount.findUnique({
    where: { tenantId: session.tenantId },
    include: { rules: { orderBy: { createdAt: 'asc' } } },
  });

  if (!adAccount) {
    return apiSuccess({
      configured: false,
      config: null,
      rules: [],
    });
  }

  return apiSuccess({
    configured: true,
    config: {
      id: adAccount.id,
      metaAdAccountId: adAccount.metaAdAccountId ?? '',
      metaPageId: adAccount.metaPageId ?? '',
      metaPixelId: adAccount.metaPixelId ?? '',
      hasMetaAccessToken: !!adAccount.metaAccessToken,
      driveFolderId: adAccount.driveFolderId ?? '',
      hasDriveApiKey: !!adAccount.driveApiKey,
      notifyEmail: adAccount.notifyEmail ?? '',
      notifyWebhook: adAccount.notifyWebhook ?? '',
      isActive: adAccount.isActive,
      scanSchedule: adAccount.scanSchedule,
      monitorSchedule: adAccount.monitorSchedule,
    },
    rules: adAccount.rules.map((r) => ({
      id: r.id,
      name: r.name,
      metric: r.metric,
      operator: r.operator,
      threshold: r.threshold,
      windowHours: r.windowHours,
      action: r.action,
      isActive: r.isActive,
    })),
  });
}

// Cron expression validation — 5 fields separated by whitespace.
// Allows standard cron syntax: numbers, ranges, steps, lists, wildcards.
const CRON_REGEX =
  /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/;

// POST body schema. All fields are optional — caller sends only what changed.
const adsConfigSchema = z.object({
  metaAdAccountId: z.string().max(100).optional(),
  metaPageId:      z.string().max(100).optional(),
  metaPixelId:     z.string().max(100).optional(),
  metaAccessToken: z.string().min(1).max(512).optional(),
  driveFolderId:   z.string().max(200).optional(),
  driveApiKey:     z.string().min(1).max(512).optional(),
  // notifyEmail: standard RFC-5322 email (Zod validates format)
  notifyEmail: z.string().email('notifyEmail must be a valid email').max(254).optional(),
  // notifyWebhook: must be HTTPS to prevent SSRF to internal/non-TLS endpoints
  notifyWebhook: z
    .string()
    .url('notifyWebhook must be a valid URL')
    .max(2048)
    .refine((url) => url.startsWith('https://'), {
      message: 'notifyWebhook must use HTTPS',
    })
    .optional()
    .or(z.literal('')),   // allow clearing the field with an empty string
  isActive:        z.boolean().optional(),
  scanSchedule:    z.string().regex(CRON_REGEX, 'Invalid cron expression').optional(),
  monitorSchedule: z.string().regex(CRON_REGEX, 'Invalid cron expression').optional(),
  rules: z
    .array(
      z.object({
        name:        z.string().min(1).max(200),
        metric:      z.string().min(1).max(100),
        operator:    z.enum(['lt', 'gt', 'lte', 'gte']),
        threshold:   z.number().finite(),
        windowHours: z.number().int().min(1).max(8760),   // 1 h – 1 year
        action:      z.enum(['pause', 'notify']),
        isActive:    z.boolean().optional().default(true),
      })
    )
    .max(50)   // sane upper bound — avoids accidental mass-delete + recreate
    .optional(),
});

/**
 * POST /api/ads/config — Create or update Meta Ad Account config.
 */
export async function POST(request: Request) {
  const session = await getAuthenticatedTenant();
  if (!session) return apiError('Unauthorized', 401);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Invalid JSON', 400);
  }

  const parsed = adsConfigSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstError = parsed.error.errors[0];
    return apiError(
      `Validation error: ${firstError.path.join('.') || 'body'} — ${firstError.message}`,
      400,
    );
  }

  const {
    metaAccessToken,
    metaAdAccountId,
    metaPageId,
    metaPixelId,
    driveFolderId,
    driveApiKey,
    notifyEmail,
    notifyWebhook,
    isActive,
    scanSchedule,
    monitorSchedule,
    rules,
  } = parsed.data;

  // Build update data, only encrypt fields that are being changed
  const updateData: Record<string, unknown> = {};

  if (metaAdAccountId !== undefined) updateData.metaAdAccountId = metaAdAccountId;
  if (metaPageId !== undefined) updateData.metaPageId = metaPageId;
  if (metaPixelId !== undefined) updateData.metaPixelId = metaPixelId;
  if (notifyEmail !== undefined) updateData.notifyEmail = notifyEmail;
  if (notifyWebhook !== undefined) updateData.notifyWebhook = notifyWebhook;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (scanSchedule !== undefined) updateData.scanSchedule = scanSchedule;
  if (monitorSchedule !== undefined) updateData.monitorSchedule = monitorSchedule;
  if (driveFolderId !== undefined) updateData.driveFolderId = driveFolderId;

  // Encrypt sensitive fields
  if (metaAccessToken) updateData.metaAccessToken = encrypt(metaAccessToken);
  if (driveApiKey) updateData.driveApiKey = encrypt(driveApiKey);

  const adAccount = await db.metaAdAccount.upsert({
    where: { tenantId: session.tenantId },
    create: {
      tenantId: session.tenantId,
      ...updateData,
    },
    update: updateData,
  });

  // Handle rules if provided
  if (rules && Array.isArray(rules)) {
    // Delete existing rules and recreate
    await db.adRule.deleteMany({ where: { metaAdAccountId: adAccount.id } });

    for (const rule of rules) {
      await db.adRule.create({
        data: {
          metaAdAccountId: adAccount.id,
          name: rule.name,
          metric: rule.metric,
          operator: rule.operator,
          threshold: Number(rule.threshold),
          windowHours: Number(rule.windowHours) || 48,
          action: rule.action || 'pause',
          isActive: rule.isActive !== false,
        },
      });
    }
  }

  return apiSuccess({ id: adAccount.id, saved: true });
}
