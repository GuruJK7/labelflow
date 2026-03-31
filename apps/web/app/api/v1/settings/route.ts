import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { encryptIfPresent } from '@/lib/encryption';

const updateSchema = z.object({
  shopifyStoreUrl: z.string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/, 'Must be a valid Shopify domain (e.g. your-store.myshopify.com)')
    .optional(),
  shopifyToken: z.string().min(1).optional(),
  dacUsername: z.string().min(1).optional(),
  dacPassword: z.string().min(1).optional(),
  emailHost: z.string().min(1).optional(),
  emailPort: z.number().min(1).max(65535).optional(),
  emailUser: z.string().min(1).optional(),
  emailPass: z.string().min(1).optional(),
  emailFrom: z.string().min(1).optional(),
  storeName: z.string().max(100).optional(),
  paymentThreshold: z.number().min(0).max(1000000).optional(),
  paymentRuleEnabled: z.boolean().optional(),
  cronSchedule: z.string()
    .regex(/^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/, 'Invalid cron expression')
    .refine((val) => {
      const [min] = val.split(' ');
      if (min === '*') return false;
      if (min.startsWith('*/')) return parseInt(min.substring(2)) >= 15;
      return true;
    }, 'Minimum interval is 15 minutes')
    .optional(),
  maxOrdersPerRun: z.number().min(1).max(50).optional(),
  scheduleSlots: z.array(z.object({
    time: z.string().regex(/^\d{2}:\d{2}$/),
    maxOrders: z.number().min(0).max(50),
  })).max(10).optional(),
}).partial();

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: {
      shopifyStoreUrl: true,
      shopifyToken: true,
      dacUsername: true,
      dacPassword: true,
      emailHost: true,
      emailPort: true,
      emailUser: true,
      emailPass: true,
      emailFrom: true,
      storeName: true,
      paymentThreshold: true,
      paymentRuleEnabled: true,
      cronSchedule: true,
      maxOrdersPerRun: true,
      scheduleSlots: true,
      isActive: true,
      subscriptionStatus: true,
      stripePriceId: true,
      stripeSubscriptionId: true,
      currentPeriodEnd: true,
      labelsThisMonth: true,
      labelsTotal: true,
      apiKey: true,
    },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  // Never return encrypted values, return booleans instead
  return apiSuccess({
    shopifyStoreUrl: tenant.shopifyStoreUrl,
    shopifyTokenSet: !!tenant.shopifyToken,
    dacUsername: tenant.dacUsername,
    dacPasswordSet: !!tenant.dacPassword,
    emailHost: tenant.emailHost,
    emailPort: tenant.emailPort,
    emailUser: tenant.emailUser,
    emailPassSet: !!tenant.emailPass,
    emailFrom: tenant.emailFrom,
    storeName: tenant.storeName,
    paymentThreshold: tenant.paymentThreshold,
    paymentRuleEnabled: tenant.paymentRuleEnabled,
    cronSchedule: tenant.cronSchedule,
    maxOrdersPerRun: tenant.maxOrdersPerRun,
    scheduleSlots: tenant.scheduleSlots,
    isActive: tenant.isActive,
    subscriptionStatus: tenant.subscriptionStatus,
    stripePriceId: tenant.stripePriceId,
    stripeSubscriptionId: tenant.stripeSubscriptionId,
    currentPeriodEnd: tenant.currentPeriodEnd,
    labelsThisMonth: tenant.labelsThisMonth,
    labelsTotal: tenant.labelsTotal,
    apiKey: tenant.apiKey,
  });
}

export async function PUT(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('Datos invalidos', 400);
  }

  const data: Record<string, unknown> = {};
  const input = parsed.data;

  // Plain fields
  if (input.shopifyStoreUrl !== undefined) data.shopifyStoreUrl = input.shopifyStoreUrl;
  if (input.dacUsername !== undefined) data.dacUsername = input.dacUsername;
  if (input.emailHost !== undefined) data.emailHost = input.emailHost;
  if (input.emailPort !== undefined) data.emailPort = input.emailPort;
  if (input.emailUser !== undefined) data.emailUser = input.emailUser;
  if (input.emailFrom !== undefined) data.emailFrom = input.emailFrom;
  if (input.storeName !== undefined) data.storeName = input.storeName;
  if (input.paymentThreshold !== undefined) data.paymentThreshold = input.paymentThreshold;
  if (input.paymentRuleEnabled !== undefined) data.paymentRuleEnabled = input.paymentRuleEnabled;
  if (input.cronSchedule !== undefined) data.cronSchedule = input.cronSchedule;
  if (input.maxOrdersPerRun !== undefined) data.maxOrdersPerRun = input.maxOrdersPerRun;
  if (input.scheduleSlots !== undefined) data.scheduleSlots = input.scheduleSlots;

  // Encrypted fields
  if (input.shopifyToken !== undefined) data.shopifyToken = encryptIfPresent(input.shopifyToken);
  if (input.dacPassword !== undefined) data.dacPassword = encryptIfPresent(input.dacPassword);
  if (input.emailPass !== undefined) data.emailPass = encryptIfPresent(input.emailPass);

  // Verify Shopify connection if token provided
  if (input.shopifyToken && input.shopifyStoreUrl) {
    try {
      const res = await fetch(
        `https://${input.shopifyStoreUrl}/admin/api/2024-01/shop.json`,
        {
          headers: { 'X-Shopify-Access-Token': input.shopifyToken },
        }
      );
      if (!res.ok) {
        return apiError('No se pudo conectar a Shopify. Verifica la URL y el token.', 422);
      }
    } catch {
      return apiError('Error verificando conexion a Shopify', 422);
    }
  }

  await db.tenant.update({
    where: { id: auth.tenantId },
    data,
  });

  return apiSuccess({ message: 'Configuracion actualizada' });
}
