import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regresión: el alta/login por Google dejaba al usuario AFUERA.
 *
 * next-auth 4.x, provider de Google, `profile()` por defecto:
 *     profile(profile) { return { id: profile.sub, ... } }
 *
 * O sea, en el callback `jwt` el `user.id` de un login por Google es el
 * `sub` de Google (un entero de 21 dígitos), NO nuestro `User.id` (cuid).
 * Como `token.id = user.id` se guardaba tal cual, todas las búsquedas
 * posteriores (`db.tenant.findFirst({ where: { userId: token.id } })`)
 * miraban un id que no existe en la base: el token quedaba sin `tenantId`,
 * `getAuthenticatedTenant()` devolvía null y el usuario rebotaba a /login.
 *
 * Con credentials nunca pasó porque `authorize()` devuelve el id de la base.
 *
 * Verificado en producción el 2026-09-14: de las 8 cuentas creadas por
 * Google desde 2026-05-01, CERO llegaron a `onboardingComplete` (las dos
 * únicas sin password que sí completaron son aprovisionadas por script).
 *
 * Para ver fallar este test: en `lib/auth.ts`, reemplazar el bloque que
 * resuelve el id por email con el viejo `token.id = user.id`.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  userCreate: vi.fn(),
  tenantCreate: vi.fn(),
  trackServer: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique, create: mocks.userCreate },
    tenant: {
      findFirst: mocks.tenantFindFirst,
      findUnique: mocks.tenantFindUnique,
      create: mocks.tenantCreate,
    },
  },
}));
vi.mock('@/lib/analytics.server', () => ({ trackServer: mocks.trackServer }));
vi.mock('@/lib/audit-log', () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock('next/headers', () => ({
  cookies: () => ({ get: () => undefined }),
  headers: () => ({ get: () => null }),
}));

import { authOptions } from '@/lib/auth';

/** El `sub` de Google: entero largo, nunca un cuid. */
const GOOGLE_SUB = '104839271056432198777';
/** El id real en nuestra base (cuid de Prisma). */
const DB_USER_ID = 'cmu1phiyx0007mrvlu2e06tpi';
const TENANT = { id: 'cmu1phiyx0009mrvlyv5av8k7', slug: 'tienda-juana' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jwt = authOptions.callbacks!.jwt as any;

beforeEach(() => {
  vi.clearAllMocks();
  // La base sólo conoce el cuid. Si alguien pregunta por el sub de Google,
  // no hay tenant — igual que en producción.
  mocks.tenantFindFirst.mockImplementation(async ({ where }: any) =>
    where?.userId === DB_USER_ID
      ? { ...TENANT, isActive: true, subscriptionStatus: 'ACTIVE' }
      : null,
  );
  mocks.userFindUnique.mockResolvedValue({ id: DB_USER_ID });
});

describe('jwt callback — identidad del usuario por Google', () => {
  it('guarda el User.id de la base, no el sub de Google', async () => {
    const token = await jwt({
      token: {},
      user: { id: GOOGLE_SUB, email: 'juana@tienda.uy', name: 'Juana' },
      account: { provider: 'google' },
    });

    expect(token.id).toBe(DB_USER_ID);
    expect(token.id).not.toBe(GOOGLE_SUB);
  });

  it('la sesión de un alta por Google queda CON tenant (no rebota a /login)', async () => {
    const token = await jwt({
      token: {},
      user: { id: GOOGLE_SUB, email: 'juana@tienda.uy', name: 'Juana' },
      account: { provider: 'google' },
    });

    // Esto es lo que rompía: sin tenantId, getAuthenticatedTenant() devuelve
    // null y cada endpoint protegido contesta "No autorizado".
    expect(token.tenantId).toBe(TENANT.id);
    expect(token.tenantSlug).toBe(TENANT.slug);
    expect(token.isActive).toBe(true);
  });

  it('el email se normaliza a minúsculas para buscar en la base', async () => {
    await jwt({
      token: {},
      user: { id: GOOGLE_SUB, email: 'Juana@Tienda.UY', name: 'Juana' },
      account: { provider: 'google' },
    });

    expect(mocks.userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'juana@tienda.uy' } }),
    );
  });

  it('si la base todavía no tiene el usuario, no rompe (cae al id que vino)', async () => {
    mocks.userFindUnique.mockResolvedValue(null);

    const token = await jwt({
      token: {},
      user: { id: GOOGLE_SUB, email: 'nueva@tienda.uy', name: 'Nueva' },
      account: { provider: 'google' },
    });

    expect(token.id).toBe(GOOGLE_SUB);
    expect(token.tenantId).toBeUndefined();
  });

  it('credentials sigue igual: el id ya viene de la base, no se toca', async () => {
    const token = await jwt({
      token: {},
      user: { id: DB_USER_ID, email: 'juana@tienda.uy', name: 'Juana' },
      account: { provider: 'credentials' },
    });

    expect(token.id).toBe(DB_USER_ID);
    expect(token.tenantId).toBe(TENANT.id);
    // No hace falta ir a buscar el usuario por email en este camino.
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });
});
