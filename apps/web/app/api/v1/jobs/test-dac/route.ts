import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { isJobRunning } from '@/lib/queue';

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
  // Security: NEVER persist `dacPassword` in plaintext here. RunLog.meta
  // is returned to the tenant via GET /api/v1/logs and a stale row would
  // leak the operator's DAC credentials forever. The worker reads the
  // password directly from Tenant.dacPassword (encrypted at rest) — this
  // log row only carries non-secret config (username is encrypted at rest
  // too but the in-memory username here is plaintext, which we accept since
  // it's not a credential on its own and the worker needs it to scope the
  // test). Audit 2026-04-27 H-04.
  await db.runLog.create({
    data: {
      jobId: job.id,
      tenantId: auth.tenantId,
      level: 'INFO',
      message: 'testDacConfig',
      meta: {
        testDac: true,
        dacUsername,
        dacPasswordSet: !!dacPassword, // boolean only — NEVER the value
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
