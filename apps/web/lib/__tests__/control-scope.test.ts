import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Alcance del Centro de Control (D32, revisión 2026-09-02): el usuario ve
 * sus tenants; el admin (ADMIN_EMAILS) ve además todos los activos. El rol
 * sale de la fila del User, no del JWT.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  userFindUnique: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }));

import { getControlActor, controlTenantWhere } from '@/lib/control-scope';

const ENV_BACKUP = { ADMIN_EMAILS: process.env.ADMIN_EMAILS, ADMIN_EMAIL: process.env.ADMIN_EMAIL };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = 'admin@autoenvia.com, Adrian@Gmail.com';
  delete process.env.ADMIN_EMAIL;
  mocks.getAuthenticatedUser.mockResolvedValue({ userId: 'u1' });
  mocks.userFindUnique.mockResolvedValue({ email: 'cliente@tienda.uy' });
});
afterEach(() => {
  if (ENV_BACKUP.ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ENV_BACKUP.ADMIN_EMAILS;
  if (ENV_BACKUP.ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = ENV_BACKUP.ADMIN_EMAIL;
});

describe('getControlActor', () => {
  it('sin sesión → null y no consulta la base', async () => {
    mocks.getAuthenticatedUser.mockResolvedValueOnce(null);
    expect(await getControlActor()).toBeNull();
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });

  it('usuario normal → isAdmin false, leyendo el email de la fila del User', async () => {
    expect(await getControlActor()).toEqual({ userId: 'u1', isAdmin: false });
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { email: true } });
  });

  it('email en ADMIN_EMAILS (insensible a mayúsculas) → isAdmin true', async () => {
    mocks.userFindUnique.mockResolvedValueOnce({ email: 'ADRIAN@gmail.com' });
    expect(await getControlActor()).toEqual({ userId: 'u1', isAdmin: true });
  });

  it('sin fila de User, o sin ADMIN_EMAILS, nadie es admin', async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    expect((await getControlActor())?.isAdmin).toBe(false);
    delete process.env.ADMIN_EMAILS;
    mocks.userFindUnique.mockResolvedValueOnce({ email: 'admin@autoenvia.com' });
    expect((await getControlActor())?.isAdmin).toBe(false);
  });
});

describe('controlTenantWhere', () => {
  it('usuario normal → exactamente sus tenants (lo de siempre)', () => {
    expect(controlTenantWhere({ userId: 'u1', isAdmin: false })).toEqual({ userId: 'u1' });
  });

  it('admin → los propios (activos o no) más todos los activos de cualquiera', () => {
    expect(controlTenantWhere({ userId: 'u1', isAdmin: true })).toEqual({
      OR: [{ userId: 'u1' }, { isActive: true }],
    });
  });
});
