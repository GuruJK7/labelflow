import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Centro de Control para el admin (D32, revisión 2026-09-02). Adrian pidió que
 * cuando un cliente completa el onboarding su tienda le aparezca en Control.
 *
 * Lo que fijan estos tests, ruta por ruta, con una tabla de tenants en memoria
 * y el `where` evaluado de verdad (no la forma del objeto):
 *   - el usuario normal sigue viendo y operando SOLO sus tiendas (403 en ajenas);
 *   - el admin ve las propias (activas o no) más todas las ACTIVAS de todos,
 *     cada una con el email del dueño, y puede ejecutar/reintentar/ver sobre
 *     ellas; una ajena INACTIVA le da el mismo 403;
 *   - el wallet del overview es el del que mira, nunca el del cliente.
 */
interface TenantRow {
  id: string;
  userId: string;
  name: string;
  slug: string;
  isActive: boolean;
  subscriptionStatus: string;
  shipmentCredits: number;
  referralBonusCredits: number;
  stripePriceId: string | null;
  labelsThisMonth: number;
  createdAt: Date;
  shopifyStoreUrl: string | null;
  shopifyToken: string | null;
  dacUsername: string | null;
  dacPassword: string | null;
  dashboardSourceEnabled: boolean;
  dashboardUrl: string | null;
  dashboardToken: string | null;
  lastRunAt: Date | null;
  maxOrdersPerRun: number;
}

const USERS = [
  { id: 'u-admin', email: 'admin@autoenvia.com' },
  { id: 'u-cli', email: 'cliente@tienda.uy' },
  { id: 'u-otro', email: 'otro@x.com' },
];

function tenant(p: Partial<TenantRow> & Pick<TenantRow, 'id' | 'userId' | 'isActive' | 'createdAt'>): TenantRow {
  return {
    name: p.id,
    slug: p.id,
    subscriptionStatus: 'INACTIVE',
    shipmentCredits: 0,
    referralBonusCredits: 0,
    stripePriceId: null,
    labelsThisMonth: 0,
    shopifyStoreUrl: null,
    shopifyToken: null,
    dacUsername: null,
    dacPassword: null,
    dashboardSourceEnabled: false,
    dashboardUrl: null,
    dashboardToken: null,
    lastRunAt: null,
    maxOrdersPerRun: 10,
    ...p,
  };
}

const TENANTS: TenantRow[] = [
  tenant({ id: 't-admin-1', userId: 'u-admin', isActive: true, createdAt: new Date('2026-01-01'), shipmentCredits: 20 }),
  tenant({ id: 't-admin-2', userId: 'u-admin', isActive: false, createdAt: new Date('2026-02-01') }),
  tenant({ id: 't-cli-1', userId: 'u-cli', isActive: true, createdAt: new Date('2026-03-01'), shipmentCredits: 5, shopifyStoreUrl: 'cli.myshopify.com', shopifyToken: 'tok' }),
  tenant({ id: 't-cli-2', userId: 'u-cli', isActive: false, createdAt: new Date('2026-04-01') }),
  tenant({ id: 't-otro', userId: 'u-otro', isActive: true, createdAt: new Date('2026-05-01'), shipmentCredits: 1, dashboardSourceEnabled: true, dashboardUrl: 'https://depo.example', dashboardToken: 'dtok' }),
];
const LABELS = [{ id: 'lbl-cli', tenantId: 't-cli-1', pdfPath: 'labels/cli.pdf' }];

type Where = Record<string, unknown>;

/** Evalúa el `where` de Prisma que usan las rutas de Control sobre la tabla. */
function matches(row: TenantRow, where: Where): boolean {
  for (const [k, v] of Object.entries(where)) {
    switch (k) {
      case 'OR':
        if (!(v as Where[]).some((w) => matches(row, w))) return false;
        break;
      case 'id':
        if (typeof v === 'string') {
          if (row.id !== v) return false;
        } else if (v && typeof v === 'object' && 'in' in v) {
          if (!(v as { in: string[] }).in.includes(row.id)) return false;
        } else {
          throw new Error(`filtro id no contemplado: ${JSON.stringify(v)}`);
        }
        break;
      case 'userId':
        if (row.userId !== v) return false;
        break;
      case 'isActive':
        if (row.isActive !== v) return false;
        break;
      default:
        throw new Error(`filtro no contemplado "${k}"`);
    }
  }
  return true;
}
function ordered(rows: TenantRow[]): TenantRow[] {
  return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  tenantFindMany: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  labelGroupBy: vi.fn(),
  labelFindMany: vi.fn(),
  labelFindFirst: vi.fn(),
  jobFindMany: vi.fn(),
  leaseFindMany: vi.fn(),
  runLogCreate: vi.fn(),
  getStuckBreakdown: vi.fn(),
  enqueueProcessOrders: vi.fn(),
  isJobRunning: vi.fn(),
  getCreditHolderTenantId: vi.fn(),
  warmShopifyToken: vi.fn(),
  runRetryForTenant: vi.fn(),
  getUnfulfilledCount: vi.fn(),
  maybeReconcileStuck: vi.fn(),
  signedLabelPdfUrl: vi.fn(),
}));

vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique, findMany: mocks.userFindMany },
    tenant: { findMany: mocks.tenantFindMany, findFirst: mocks.tenantFindFirst, findUnique: mocks.tenantFindUnique },
    label: { groupBy: mocks.labelGroupBy, findMany: mocks.labelFindMany, findFirst: mocks.labelFindFirst },
    job: { findMany: mocks.jobFindMany },
    dacProcessingLease: { findMany: mocks.leaseFindMany },
    runLog: { create: mocks.runLogCreate },
  },
}));
vi.mock('@/lib/stuck-labels', () => ({ getStuckBreakdown: mocks.getStuckBreakdown }));
vi.mock('@/lib/queue', () => ({ enqueueProcessOrders: mocks.enqueueProcessOrders, isJobRunning: mocks.isJobRunning }));
vi.mock('@/lib/credit-holder', () => ({ getCreditHolderTenantId: mocks.getCreditHolderTenantId }));
vi.mock('@/lib/mercadopago', () => ({ getPlanLimit: () => 0 }));
vi.mock('@/lib/shopify-access', () => ({ warmShopifyToken: mocks.warmShopifyToken }));
vi.mock('@/lib/retry-runner', () => ({ runRetryForTenant: mocks.runRetryForTenant }));
vi.mock('@/lib/shopify-pending', () => ({ getUnfulfilledCount: mocks.getUnfulfilledCount }));
vi.mock('@/lib/shopify-reconcile', () => ({
  maybeReconcileStuck: mocks.maybeReconcileStuck,
  isResolvedExternally: () => false,
}));
vi.mock('@/lib/label-pdf', () => ({ signedLabelPdfUrl: mocks.signedLabelPdfUrl }));

import { GET as overview } from '@/app/api/v1/control/overview/route';
import { GET as pending } from '@/app/api/v1/control/pending/route';
import { POST as run } from '@/app/api/v1/control/run/route';
import { POST as retry } from '@/app/api/v1/control/retry/route';
import { GET as labels } from '@/app/api/v1/control/labels/route';
import { GET as recentLabels } from '@/app/api/v1/control/recent-labels/route';
import { GET as shipments } from '@/app/api/v1/control/shipments/route';
import { GET as pdf } from '@/app/api/v1/control/labels/[id]/pdf/route';

const ADMIN_BACKUP = process.env.ADMIN_EMAILS;

function loginAs(userId: string) {
  mocks.getAuthenticatedUser.mockResolvedValue({ userId });
}
function post(handler: (req: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request('https://autoenvia.com/api/v1/control/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
function get(handler: (req: NextRequest) => Promise<Response>, path: string) {
  return handler(new NextRequest(new URL(path, 'https://autoenvia.com')));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  process.env.ADMIN_EMAILS = 'admin@autoenvia.com';

  mocks.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    USERS.find((u) => u.id === where.id) ?? null,
  );
  mocks.userFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    USERS.filter((u) => where.id.in.includes(u.id)),
  );
  mocks.tenantFindMany.mockImplementation(async ({ where }: { where: Where }) =>
    ordered(TENANTS.filter((t) => matches(t, where))),
  );
  mocks.tenantFindFirst.mockImplementation(async ({ where }: { where: Where }) =>
    ordered(TENANTS.filter((t) => matches(t, where)))[0] ?? null,
  );
  mocks.tenantFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    TENANTS.find((t) => t.id === where.id) ?? null,
  );
  mocks.labelFindFirst.mockImplementation(async ({ where }: { where: { id: string; tenant: Where } }) => {
    const l = LABELS.find((x) => x.id === where.id);
    if (!l) return null;
    const t = TENANTS.find((x) => x.id === l.tenantId)!;
    return matches(t, where.tenant) ? { pdfPath: l.pdfPath } : null;
  });
  mocks.labelGroupBy.mockResolvedValue([]);
  mocks.labelFindMany.mockResolvedValue([]);
  mocks.jobFindMany.mockResolvedValue([]);
  mocks.leaseFindMany.mockResolvedValue([]);
  mocks.runLogCreate.mockResolvedValue({});
  mocks.getStuckBreakdown.mockResolvedValue({ count: 0, total: 0, retryable: 0, orphan: 0, remitente: 0, needsAddress: 0 });
  mocks.enqueueProcessOrders.mockResolvedValue('job-1');
  mocks.isJobRunning.mockResolvedValue(false);
  // Holder real: el tenant más viejo del DUEÑO de la tienda (no del que aprieta).
  mocks.getCreditHolderTenantId.mockImplementation(async (tenantId: string) => {
    const t = TENANTS.find((x) => x.id === tenantId)!;
    return ordered(TENANTS.filter((x) => x.userId === t.userId))[0].id;
  });
  mocks.warmShopifyToken.mockResolvedValue(undefined);
  mocks.runRetryForTenant.mockResolvedValue({ retried: 1 });
  mocks.getUnfulfilledCount.mockImplementation(async (tenantId: string) => ({ tenantId, count: 0, cached: false }));
  mocks.maybeReconcileStuck.mockResolvedValue(undefined);
  mocks.signedLabelPdfUrl.mockResolvedValue('https://storage.example/signed.pdf');
});
afterEach(() => {
  if (ADMIN_BACKUP === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ADMIN_BACKUP;
});

describe('GET /api/v1/control/overview', () => {
  it('usuario normal: sus tiendas (activas o no), sin `owner` ni `adminView`, wallet propio — nada cambia', async () => {
    loginAs('u-cli');
    const res = await overview();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.stores.map((s: { id: string }) => s.id)).toEqual(['t-cli-1', 't-cli-2']);
    expect(data.stores.every((s: Record<string, unknown>) => !('owner' in s))).toBe(true);
    expect('adminView' in data).toBe(false);
    expect(data.wallet).toEqual({ availableCredits: 5, isActive: true, subscriptionStatus: 'INACTIVE' });
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it('admin: las propias (también la inactiva) + todas las activas de todos, con el email del dueño; la ajena inactiva NO', async () => {
    loginAs('u-admin');
    const { data } = await (await overview()).json();
    expect(data.adminView).toBe(true);
    expect(data.stores.map((s: { id: string }) => s.id)).toEqual(['t-admin-1', 't-admin-2', 't-cli-1', 't-otro']);
    expect(data.stores.map((s: { owner: unknown }) => s.owner)).toEqual([
      { email: 'admin@autoenvia.com', own: true },
      { email: 'admin@autoenvia.com', own: true },
      { email: 'cliente@tienda.uy', own: false },
      { email: 'otro@x.com', own: false },
    ]);
  });

  it('admin: el wallet es el del admin (su holder), no el del cliente', async () => {
    loginAs('u-admin');
    const { data } = await (await overview()).json();
    expect(data.wallet.availableCredits).toBe(20);
  });

  it('admin sin ADMIN_EMAILS cargada = usuario normal', async () => {
    delete process.env.ADMIN_EMAILS;
    loginAs('u-admin');
    const { data } = await (await overview()).json();
    expect(data.stores.map((s: { id: string }) => s.id)).toEqual(['t-admin-1', 't-admin-2']);
    expect('adminView' in data).toBe(false);
  });

  it('la respuesta nunca trae tokens ni contraseñas', async () => {
    loginAs('u-admin');
    const body = JSON.stringify(await (await overview()).json());
    expect(body).not.toMatch(/shopifyToken|dacPassword|dacUsername/);
  });
});

describe('POST /api/v1/control/run', () => {
  it('usuario normal sobre una tienda ajena → 403 y no encola (como siempre)', async () => {
    loginAs('u-cli');
    const res = await post(run, { tenantId: 't-otro', maxOrders: 5 });
    expect(res.status).toBe(403);
    expect(mocks.enqueueProcessOrders).not.toHaveBeenCalled();
  });

  it('usuario normal sobre la propia → encola (sin cambios)', async () => {
    loginAs('u-cli');
    const res = await post(run, { tenantId: 't-cli-1', maxOrders: 5 });
    expect(res.status).toBe(200);
    expect(mocks.enqueueProcessOrders).toHaveBeenCalledWith('t-cli-1', 'MANUAL', { type: 'PROCESS_ORDERS' });
  });

  it('admin sobre la tienda activa de un cliente → encola, con el gate evaluado sobre el holder del cliente', async () => {
    loginAs('u-admin');
    const res = await post(run, { tenantId: 't-cli-1', maxOrders: 3 });
    expect(res.status).toBe(200);
    expect(mocks.enqueueProcessOrders).toHaveBeenCalledWith('t-cli-1', 'MANUAL', { type: 'PROCESS_ORDERS' });
    expect(mocks.getCreditHolderTenantId).toHaveBeenCalledWith('t-cli-1');
    expect(mocks.runLogCreate.mock.calls[0][0].data).toMatchObject({ tenantId: 't-cli-1', message: 'maxOrdersOverride=3' });
  });

  it('admin sobre una tienda ajena INACTIVA → 403 (no está en la lista, no se opera)', async () => {
    loginAs('u-admin');
    const res = await post(run, { tenantId: 't-cli-2' });
    expect(res.status).toBe(403);
    expect(mocks.enqueueProcessOrders).not.toHaveBeenCalled();
  });

  it('admin sobre un cliente sin saldo → el 403 del gate del CLIENTE, no del admin', async () => {
    loginAs('u-admin');
    const res = await post(run, { tenantId: 't-otro' }); // t-otro tiene 1 crédito → pasa; simulamos sin saldo
    expect(res.status).toBe(200);
    mocks.tenantFindUnique.mockImplementationOnce(async () => ({ ...TENANTS[4], shipmentCredits: 0 }));
    const sinSaldo = await post(run, { tenantId: 't-otro' });
    expect(sinSaldo.status).toBe(403);
    expect(await sinSaldo.json()).toEqual({ error: 'Te quedaste sin envíos. Comprá un pack para seguir despachando.' });
  });

  // ── Lo que estaba roto hasta 2026-09-05 ────────────────────────────────────
  // Esta ruta encolaba SIEMPRE `PROCESS_ORDERS` (el procesador de Shopify). Para
  // una tienda de la fuente dashboard —VentaFlow, y las cuentas que opera el
  // depósito— el botón contestaba 200 "Job encolado" y no despachaba nada,
  // porque ese job no tiene de dónde leer pedidos. Sin error, sin señal.
  it('tienda de la fuente dashboard → encola PROCESS_DASHBOARD_ORDERS y no toca Shopify', async () => {
    loginAs('u-admin');
    const res = await post(run, { tenantId: 't-otro' });
    expect(res.status).toBe(200);
    expect(mocks.enqueueProcessOrders).toHaveBeenCalledWith('t-otro', 'MANUAL', {
      type: 'PROCESS_DASHBOARD_ORDERS',
    });
    // No hay token de Shopify que renovar: pedirlo sería una llamada al pedo
    // que además puede fallar y ensuciar el log.
    expect(mocks.warmShopifyToken).not.toHaveBeenCalled();
  });

  it('fuente dashboard con límite por corrida → 422 (ese job despacharía todo igual)', async () => {
    loginAs('u-admin');
    const res = await post(run, { tenantId: 't-otro', maxOrders: 1 });
    expect(res.status).toBe(422);
    expect(mocks.enqueueProcessOrders).not.toHaveBeenCalled();
  });

  it('tienda sin ninguna fuente conectada → 422 en vez de un job que no despacha nada', async () => {
    loginAs('u-admin');
    const res = await post(run, { tenantId: 't-admin-1' });
    expect(res.status).toBe(422);
    expect(mocks.enqueueProcessOrders).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/control/retry', () => {
  it('usuario normal sobre ajena → 403; admin sobre ajena activa → reintenta', async () => {
    loginAs('u-cli');
    expect((await post(retry, { tenantId: 't-otro', count: 2 })).status).toBe(403);
    expect(mocks.runRetryForTenant).not.toHaveBeenCalled();

    loginAs('u-admin');
    mocks.tenantFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      ...TENANTS.find((t) => t.id === where.id)!,
      subscriptionStatus: 'ACTIVE',
    }));
    expect((await post(retry, { tenantId: 't-otro', count: 2 })).status).toBe(200);
    expect(mocks.runRetryForTenant).toHaveBeenCalledWith('t-otro', 2);
  });
});

describe('GET /api/v1/control/labels y labels/[id]/pdf', () => {
  it('labels: usuario normal sobre ajena → 403; admin sobre ajena activa → 200', async () => {
    loginAs('u-otro');
    expect((await get(labels, '/api/v1/control/labels?tenantId=t-cli-1')).status).toBe(403);
    loginAs('u-admin');
    expect((await get(labels, '/api/v1/control/labels?tenantId=t-cli-1')).status).toBe(200);
    expect(mocks.labelFindMany.mock.calls[0][0].where).toEqual({ tenantId: 't-cli-1' });
  });

  it('pdf: la etiqueta de un cliente la abre el admin (302) y no otro usuario (404)', async () => {
    const ctx = { params: Promise.resolve({ id: 'lbl-cli' }) };
    loginAs('u-otro');
    expect((await pdf(new NextRequest('https://autoenvia.com/x'), ctx)).status).toBe(404);
    loginAs('u-admin');
    const res = await pdf(new NextRequest('https://autoenvia.com/x'), ctx);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://storage.example/signed.pdf');
  });
});

describe('GET pending / recent-labels / shipments — mismo alcance que el overview', () => {
  it('pending: el admin consulta las 4 tiendas de la lista; el usuario, sus 2', async () => {
    loginAs('u-admin');
    const { data } = await (await get(pending, '/api/v1/control/pending')).json();
    expect(data.pending.map((p: { tenantId: string }) => p.tenantId)).toEqual(['t-admin-1', 't-admin-2', 't-cli-1', 't-otro']);
    mocks.getUnfulfilledCount.mockClear();
    loginAs('u-cli');
    await get(pending, '/api/v1/control/pending');
    expect(mocks.getUnfulfilledCount.mock.calls.map((c) => c[0])).toEqual(['t-cli-1', 't-cli-2']);
  });

  it('recent-labels y shipments filtran por los tenantIds del alcance', async () => {
    loginAs('u-admin');
    await get(recentLabels, '/api/v1/control/recent-labels');
    expect(mocks.labelFindMany.mock.calls[0][0].where.tenantId).toEqual({ in: ['t-admin-1', 't-admin-2', 't-cli-1', 't-otro'] });
    await get(shipments, '/api/v1/control/shipments?range=7');
    expect(mocks.labelGroupBy.mock.calls[0][0].where.tenantId).toEqual({ in: ['t-admin-1', 't-admin-2', 't-cli-1', 't-otro'] });

    mocks.labelFindMany.mockClear();
    loginAs('u-otro');
    await get(recentLabels, '/api/v1/control/recent-labels');
    expect(mocks.labelFindMany.mock.calls[0][0].where.tenantId).toEqual({ in: ['t-otro'] });
  });
});
