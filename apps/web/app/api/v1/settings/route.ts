import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { encryptIfPresent } from '@/lib/encryption';

const updateSchema = z.object({
  shopifyStoreUrl: z.string().optional(),
  shopifyToken: z.string().optional(),
  dacUsername: z.string().optional(),
  dacPassword: z.string().optional(),
  emailHost: z.string().optional(),
  emailPort: z.number().optional(),
  emailUser: z.string().optional(),
  emailPass: z.string().optional(),
  emailFrom: z.string().optional(),
  storeName: z.string().optional(),
  paymentThreshold: z.number().min(0).optional(),
  cronSchedule: z.string().optional(),
  maxOrdersPerRun: z.number().min(1).max(100).optional(),
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
      cronSchedule: true,
      maxOrdersPerRun: true,
      isActive: true,
      subscriptionStatus: true,
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
    cronSchedule: tenant.cronSchedule,
    maxOrdersPerRun: tenant.maxOrdersPerRun,
    isActive: tenant.isActive,
    subscriptionStatus: tenant.subscriptionStatus,
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
  if (input.cronSchedule !== undefined) data.cronSchedule = input.cronSchedule;
  if (input.maxOrdersPerRun !== undefined) data.maxOrdersPerRun = input.maxOrdersPerRun;

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
