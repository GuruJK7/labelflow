import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

/**
 * POST /api/ads/scan — Trigger a Drive scan and ad upload job.
 */
export async function POST() {
  const session = await getAuthenticatedTenant();
  if (!session) return apiError('Unauthorized', 401);

  const adAccount = await db.metaAdAccount.findUnique({
    where: { tenantId: session.tenantId },
  });

  if (!adAccount) {
    return apiError('Meta Ads no configurado. Ve a Configuracion para conectar tu cuenta.', 400);
  }

  if (!adAccount.metaAccessToken || !adAccount.metaAdAccountId) {
    return apiError('Faltan credenciales de Meta. Configura tu token de acceso y cuenta.', 400);
  }

  if (!adAccount.driveApiKey || !adAccount.driveFolderId) {
    return apiError('Faltan credenciales de Google Drive. Configura tu API key y carpeta.', 400);
  }

  // Check for running job
  const runningJob = await db.adUploadJob.findFirst({
    where: {
      metaAdAccountId: adAccount.id,
      status: { in: ['PENDING', 'RUNNING'] },
    },
  });

  if (runningJob) {
    return apiError('Ya hay un escaneo en curso. Espera a que termine.', 409);
  }

  // Create upload job
  const job = await db.adUploadJob.create({
    data: {
      metaAdAccountId: adAccount.id,
      trigger: 'MANUAL',
      status: 'PENDING',
    },
  });

  return apiSuccess({ jobId: job.id, status: 'PENDING' });
}
