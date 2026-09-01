import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/v1/onboarding/complete — la única puerta que prende `isActive`
 * (y con eso el cron del worker). D25: exige email verificado, sin importar
 * `EMAIL_VERIFICATION_REQUIRED`.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantUpdate: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: { tenant: { findUnique: mocks.tenantFindUnique, update: mocks.tenantUpdate } },
}));

import { POST } from '@/app/api/v1/onboarding/complete/route';

const TENANT_LISTO = {
  shopifyStoreUrl: 'mitienda.myshopify.com',
  shopifyToken: 'enc:token',
  dacUsername: 'enc:user',
  dacPassword: 'enc:pass',
  onboardingComplete: false,
  user: { email: 'juana@tienda.uy', emailVerified: new Date('2026-09-01T00:00:00Z') },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1', tenantId: 'tenant-1', isActive: false, subscriptionStatus: 'INACTIVE',
  });
  mocks.tenantFindUnique.mockResolvedValue(TENANT_LISTO);
  mocks.tenantUpdate.mockResolvedValue({});
});

describe('POST /api/v1/onboarding/complete', () => {
  it('sin sesión → 401 sin tocar la base', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValueOnce(null);
    expect((await POST()).status).toBe(401);
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled();
  });

  it('con Shopify + DAC + email verificado activa el tenant', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const upd = mocks.tenantUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'tenant-1' });
    expect(upd.data).toMatchObject({ onboardingComplete: true, isActive: true });
    // El select trae el usuario: es lo que hace posible el gate de abajo.
    expect(mocks.tenantFindUnique.mock.calls[0][0].select.user).toEqual({
      select: { email: true, emailVerified: true },
    });
  });

  it('email SIN verificar → 422 con código y email, y NO activa (D25)', async () => {
    mocks.tenantFindUnique.mockResolvedValueOnce({
      ...TENANT_LISTO,
      user: { email: 'juana@tienda.uy', emailVerified: null },
    });
    const res = await POST();
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Confirmá tu email/);
    expect(body.code).toBe('email_not_verified');
    expect(body.email).toBe('juana@tienda.uy');
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('el gate de email no depende de EMAIL_VERIFICATION_REQUIRED', async () => {
    const prev = process.env.EMAIL_VERIFICATION_REQUIRED;
    delete process.env.EMAIL_VERIFICATION_REQUIRED;
    try {
      mocks.tenantFindUnique.mockResolvedValueOnce({
        ...TENANT_LISTO,
        user: { email: 'juana@tienda.uy', emailVerified: null },
      });
      expect((await POST()).status).toBe(422);
      expect(mocks.tenantUpdate).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.EMAIL_VERIFICATION_REQUIRED = prev;
    }
  });

  it('faltan credenciales → 422 antes de mirar el email', async () => {
    mocks.tenantFindUnique.mockResolvedValueOnce({
      ...TENANT_LISTO,
      dacUsername: null,
      user: { email: 'juana@tienda.uy', emailVerified: null },
    });
    const res = await POST();
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Falta conectar DAC');
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('tenant ya completo → 200 alreadyComplete aunque el email no esté verificado (no rompe a los existentes)', async () => {
    mocks.tenantFindUnique.mockResolvedValueOnce({
      ...TENANT_LISTO,
      onboardingComplete: true,
      user: { email: 'vieja@tienda.uy', emailVerified: null },
    });
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ ok: true, alreadyComplete: true });
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });
});
