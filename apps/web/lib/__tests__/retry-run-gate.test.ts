import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El gate de los REINTENTOS.
 *
 * QUÉ ROMPÍA. Las tres vías de reintento exigían
 * `subscriptionStatus === 'ACTIVE'`. Ese campo lo escribe únicamente el flujo
 * legacy de suscripción recurrente de MercadoPago; el modelo vigente —packs de
 * créditos— no lo toca nunca. O sea: TODO cliente nuevo, con la cuenta activa y
 * saldo comprado, recibía 403 "Activá una suscripción" al reintentar un envío
 * fallido. Y era desconcertante porque el cron sí le corría: el scheduler mira
 * `isActive` + saldo, no la suscripción.
 *
 * `POST /api/v1/jobs` y `/api/v1/control/run` ya se habían migrado a
 * `checkRunGate` el 2026-09-01; estas tres rutas quedaron atrás. El test cubre
 * las tres para que no vuelvan a divergir del cron por separado.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantFindFirst: vi.fn(),
  getCreditHolderTenantId: vi.fn(),
  runRetryForTenant: vi.fn(),
  maybeReconcileStuck: vi.fn(),
  getStuckBreakdown: vi.fn(),
  getControlActor: vi.fn(),
  controlTenantWhere: vi.fn(),
  auditControlAccess: vi.fn(),
}));

vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: { tenant: { findUnique: mocks.tenantFindUnique, findFirst: mocks.tenantFindFirst } },
}));
vi.mock('@/lib/credit-holder', () => ({ getCreditHolderTenantId: mocks.getCreditHolderTenantId }));
vi.mock('@/lib/retry-runner', () => ({ runRetryForTenant: mocks.runRetryForTenant }));
vi.mock('@/lib/shopify-reconcile', () => ({ maybeReconcileStuck: mocks.maybeReconcileStuck }));
vi.mock('@/lib/stuck-labels', () => ({ getStuckBreakdown: mocks.getStuckBreakdown }));
vi.mock('@/lib/control-scope', () => ({
  getControlActor: mocks.getControlActor,
  controlTenantWhere: mocks.controlTenantWhere,
  // Registra el acceso del operador a un tenant ajeno. Acá se mockea porque
  // este test es sobre el GATE de saldo, no sobre la auditoría (que tiene el
  // suyo en auditoria-acceso-datos.test.ts).
  auditControlAccess: mocks.auditControlAccess,
}));

import { POST as retryFailed } from '@/app/api/v1/labels/retry-failed/route';
import { POST as controlRetry } from '@/app/api/v1/control/retry/route';

/** Cliente de packs: activo, SIN suscripción legacy, con saldo comprado. */
const CLIENTE_DE_PACKS = {
  isActive: true,
  subscriptionStatus: 'INACTIVE',
  shipmentCredits: 12,
  referralBonusCredits: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedTenant.mockResolvedValue({ tenantId: 't1' });
  mocks.getCreditHolderTenantId.mockResolvedValue('t1');
  mocks.tenantFindUnique.mockResolvedValue(CLIENTE_DE_PACKS);
  mocks.tenantFindFirst.mockResolvedValue({ id: 't1' });
  mocks.getControlActor.mockResolvedValue({ userId: 'u1', isAdmin: false });
  mocks.controlTenantWhere.mockReturnValue({});
  mocks.auditControlAccess.mockResolvedValue(undefined);
  mocks.runRetryForTenant.mockResolvedValue({ retried: 3 });
});

function pedido(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('reintentos: el gate es saldo, no suscripción', () => {
  it('un cliente de packs puede reintentar desde su panel', async () => {
    const res = await retryFailed(pedido('https://autoenvia.com/api/v1/labels/retry-failed', { count: 3 }));
    expect(res.status).toBe(200);
    expect(mocks.runRetryForTenant).toHaveBeenCalledWith('t1', 3);
  });

  it('un cliente de packs puede reintentar desde Control', async () => {
    const res = await controlRetry(pedido('https://autoenvia.com/api/v1/control/retry', { tenantId: 't1', count: 2 }));
    expect(res.status).toBe(200);
    expect(mocks.runRetryForTenant).toHaveBeenCalledWith('t1', 2);
  });

  it('sin saldo y sin suscripción, no reintenta: dice comprá un pack', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ ...CLIENTE_DE_PACKS, shipmentCredits: 0 });
    const res = await retryFailed(pedido('https://autoenvia.com/api/v1/labels/retry-failed', {}));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('Comprá un pack');
    expect(JSON.stringify(body)).not.toContain('suscripci');
    expect(mocks.runRetryForTenant).not.toHaveBeenCalled();
  });

  it('el saldo bonificado también habilita el reintento', async () => {
    mocks.tenantFindUnique.mockResolvedValue({
      ...CLIENTE_DE_PACKS,
      shipmentCredits: 0,
      referralBonusCredits: 4,
    });
    expect((await retryFailed(pedido('https://autoenvia.com/api/v1/labels/retry-failed', {}))).status).toBe(200);
  });

  it('un legacy con suscripción viva y saldo 0 sigue pudiendo reintentar', async () => {
    mocks.tenantFindUnique.mockResolvedValue({
      isActive: true,
      subscriptionStatus: 'ACTIVE',
      shipmentCredits: 0,
      referralBonusCredits: 0,
    });
    expect((await retryFailed(pedido('https://autoenvia.com/api/v1/labels/retry-failed', {}))).status).toBe(200);
  });

  it('una cuenta pausada no reintenta, tenga el saldo que tenga', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ ...CLIENTE_DE_PACKS, isActive: false });
    const res = await retryFailed(pedido('https://autoenvia.com/api/v1/labels/retry-failed', {}));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('pausada');
    expect(mocks.runRetryForTenant).not.toHaveBeenCalled();
  });
});
