import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { isJobRunning } from '@/lib/queue';
import { encrypt } from '@/lib/encryption';

// Only this tenant can use the test-dac endpoint
const ADMIN_TENANT_ID = 'cmn86ab6i0003do10kx8s8cwh';

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  if (auth.tenantId !== ADMIN_TENANT_ID) {
    return apiError('Solo el admin puede usar el modo test', 403);
  }

  let maxOrders = 3;
  let dacUsername = '';
  let dacPassword = '';
  let orderIds: string[] = [];

  try {
    const body = await req.json();
    dacUsername = body?.dacUsername ?? '';
    dacPassword = body?.dacPassword ?? '';
    if (body?.maxOrders && Number.isInteger(body.maxOrders) && body.maxOrders > 0 && body.maxOrders <= 20) {
      maxOrders = body.maxOrders;
    }
    if (Array.isArray(body?.orderIds)) {
      orderIds = body.orderIds.map(String);
    }
  } catch {
    return apiError('Body invalido — se requiere dacUsername y dacPassword', 400);
  }

  if (!dacUsername || !dacPassword) {
    return apiError('Se requiere dacUsername y dacPassword en el body', 400);
  }

  const running = await isJobRunning(auth.tenantId);
  if (running) {
    return apiError('Ya hay un job en ejecucion. Espera a que termine.', 409);
  }

  // Create TEST_DAC job
  const job = await db.job.create({
    data: {
      tenantId: auth.tenantId,
      trigger: 'TEST',
      type: 'TEST_DAC',
      status: 'PENDING',
    },
  });

  // Store test config in RunLog for the worker to read.
  //
  // Audit 2026-04-27 H-04 — security model:
  //   The worker job (apps/worker/src/jobs/test-dac.job.ts) needs the test
  //   credentials to log into DAC. Persisting them is unavoidable (the
  //   worker process is separate). Constraints:
  //     - The credential could be a NEW one being tested (different from
  //       Tenant.dacPassword), so we cannot read it from there.
  //     - RunLog.meta is exposed via GET /api/v1/logs. Plaintext is a leak.
  //   Mitigation: encrypt at rest with the same AES-256-GCM key that
  //   protects Tenant.dacPassword. The encrypted blob is opaque without
  //   ENCRYPTION_KEY (held only by the server processes). The /api/v1/logs
  //   sanitizer additionally redacts any key matching /password/i, so even
  //   the ciphertext never reaches the browser.
  await db.runLog.create({
    data: {
      jobId: job.id,
      tenantId: auth.tenantId,
      level: 'INFO',
      message: 'testDacConfig',
      meta: {
        testDac: true,
        dacUsername,
        dacPasswordEnc: encrypt(dacPassword), // AES-256-GCM, decrypted by worker
        maxOrders,
        orderIds: orderIds.length > 0 ? orderIds : null,
        fetchMode: 'recent',
      },
    },
  });

  return apiSuccess(
    { jobId: job.id, maxOrders, message: `Test DAC job creado: ${maxOrders} pedidos recientes` },
    { status: 202 }
  );
}
