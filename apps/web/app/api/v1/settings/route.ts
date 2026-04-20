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
  autoFulfillEnabled: z.boolean().optional(),
  fulfillMode: z.enum(['off', 'on', 'always']).optional(),
  consolidateConsecutiveOrders: z.boolean().optional(),
  consolidationWindowMinutes: z.number().min(1).max(1440).optional(),
  defaultPrinter: z.string().max(200).optional(),
  autoPrintEnabled: z.boolean().optional(),
  orderSortDirection: z.enum(['oldest_first', 'newest_first']).optional(),
  allowedProductTypes: z.array(z.string().min(1).max(100)).max(50).nullable().optional(),
  // Auto-payment (DAC/Plexo)
  paymentAutoEnabled: z.boolean().optional(),
  paymentCardBrand: z.enum(['mastercard', 'visa', 'oca']).nullable().optional(),
  paymentCardLast4: z.string().regex(/^\d{4}$/, 'Deben ser 4 digitos').nullable().optional(),
  paymentCardCvc: z.string().regex(/^\d{3,4}$/, 'CVC debe ser 3 o 4 digitos').optional(),
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
      lastRunAt: true,
      apiKey: true,
      autoFulfillEnabled: true,
      fulfillMode: true,
      defaultPrinter: true,
      autoPrintEnabled: true,
      orderSortDirection: true,
      allowedProductTypes: true,
      productTypeCache: true,
      consolidateConsecutiveOrders: true,
      consolidationWindowMinutes: true,
      paymentAutoEnabled: true,
      paymentCardBrand: true,
      paymentCardLast4: true,
      paymentCardCvc: true,
    },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  // Calculate real label counts from Label table
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [labelsThisMonthReal, labelsTodayReal] = await Promise.all([
    db.label.count({
      where: { tenantId: auth.tenantId, createdAt: { gte: startOfMonth } },
    }),
    db.label.count({
      where: { tenantId: auth.tenantId, createdAt: { gte: startOfDay } },
    }),
  ]);

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
    autoFulfillEnabled: tenant.autoFulfillEnabled,
    fulfillMode: tenant.fulfillMode,
    isActive: tenant.isActive,
    subscriptionStatus: tenant.subscriptionStatus,
    stripePriceId: tenant.stripePriceId,
    stripeSubscriptionId: tenant.stripeSubscriptionId,
    currentPeriodEnd: tenant.currentPeriodEnd,
    labelsThisMonth: labelsThisMonthReal,
    labelsToday: labelsTodayReal,
    labelsTotal: tenant.labelsTotal,
    lastRunAt: tenant.lastRunAt,
    apiKey: tenant.apiKey,
    defaultPrinter: tenant.defaultPrinter,
    autoPrintEnabled: tenant.autoPrintEnabled,
    orderSortDirection: tenant.orderSortDirection,
    allowedProductTypes: tenant.allowedProductTypes,
    productTypeCache: tenant.productTypeCache,
    consolidateConsecutiveOrders: tenant.consolidateConsecutiveOrders,
    consolidationWindowMinutes: tenant.consolidationWindowMinutes,
    // Auto-payment config — never leak CVC, return boolean "set" instead
    paymentAutoEnabled: tenant.paymentAutoEnabled,
    paymentCardBrand: tenant.paymentCardBrand,
    paymentCardLast4: tenant.paymentCardLast4,
    paymentCardCvcSet: !!tenant.paymentCardCvc,
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
  if (input.autoFulfillEnabled !== undefined) data.autoFulfillEnabled = input.autoFulfillEnabled;
  if (input.fulfillMode !== undefined) {
    data.fulfillMode = input.fulfillMode;
    // Sync legacy boolean field
    data.autoFulfillEnabled = input.fulfillMode !== 'off';
  }
  if (input.defaultPrinter !== undefined) data.defaultPrinter = input.defaultPrinter;
  if (input.autoPrintEnabled !== undefined) data.autoPrintEnabled = input.autoPrintEnabled;
  if (input.orderSortDirection !== undefined) data.orderSortDirection = input.orderSortDirection;
  if (input.allowedProductTypes !== undefined) data.allowedProductTypes = input.allowedProductTypes;
  if (input.consolidateConsecutiveOrders !== undefined) data.consolidateConsecutiveOrders = input.consolidateConsecutiveOrders;
  if (input.consolidationWindowMinutes !== undefined) data.consolidationWindowMinutes = input.consolidationWindowMinutes;

  // Auto-payment (plain fields)
  if (input.paymentAutoEnabled !== undefined) data.paymentAutoEnabled = input.paymentAutoEnabled;
  if (input.paymentCardBrand !== undefined) data.paymentCardBrand = input.paymentCardBrand;
  if (input.paymentCardLast4 !== undefined) data.paymentCardLast4 = input.paymentCardLast4;

  // Encrypted fields
  if (input.shopifyToken !== undefined) data.shopifyToken = encryptIfPresent(input.shopifyToken);
  if (input.dacPassword !== undefined) data.dacPassword = encryptIfPresent(input.dacPassword);
  if (input.emailPass !== undefined) data.emailPass = encryptIfPresent(input.emailPass);
  if (input.paymentCardCvc !== undefined) data.paymentCardCvc = encryptIfPresent(input.paymentCardCvc);

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

  // If DAC credentials changed, invalidate cached Playwright session cookies so the
  // worker logs in fresh with the new creds on the next cycle. Without this, the
  // worker can keep riding an active DAC session belonging to the *previous* user
  // for up to 4h (cookie TTL), silently filing guias under the wrong account.
  if (input.dacUsername !== undefined || input.dacPassword !== undefined) {
    await db.runLog.deleteMany({
      where: { tenantId: auth.tenantId, message: 'dac_cookies' },
    });
  }

  return apiSuccess({ message: 'Configuracion actualizada' });
}
