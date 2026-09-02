import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/auth/password-reset/confirm — aplica la contraseña nueva.
 * D26: usar el link demuestra control del buzón, así que en la misma
 * transacción se marca `User.emailVerified` (sin pisar una fecha previa).
 * `findUserByResetToken` es el de verdad; sólo Prisma, bcrypt y el audit
 * log están mockeados.
 */
const mocks = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  tokenUpdate: vi.fn(),
  tokenDeleteMany: vi.fn(),
  userUpdate: vi.fn(),
  transaction: vi.fn(),
  hash: vi.fn(),
  writeAuditLog: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    passwordResetToken: {
      findUnique: mocks.tokenFindUnique,
      update: mocks.tokenUpdate,
      deleteMany: mocks.tokenDeleteMany,
    },
    user: { update: mocks.userUpdate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/audit-log', () => ({
  writeAuditLog: mocks.writeAuditLog,
  extractAuditContext: () => ({ ip: null, userAgent: null }),
}));
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }));

import { POST } from '@/app/api/auth/password-reset/confirm/route';

const TOKEN = 'a'.repeat(43);

function post(body: unknown) {
  return POST(
    new Request('https://autoenvia.com/api/auth/password-reset/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function filaToken(extra: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    userId: 'u-1',
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    user: { emailVerified: null },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tokenFindUnique.mockResolvedValue(filaToken());
  // Cada op devuelve sus args para poder inspeccionarlos en la transacción.
  mocks.tokenUpdate.mockImplementation(async (a: unknown) => a);
  mocks.tokenDeleteMany.mockImplementation(async (a: unknown) => a);
  mocks.userUpdate.mockImplementation(async (a: unknown) => a);
  mocks.transaction.mockImplementation(async (ops: unknown[]) => ops);
  mocks.hash.mockResolvedValue('$2a$12$hash');
  mocks.writeAuditLog.mockResolvedValue(undefined);
});

describe('POST /api/auth/password-reset/confirm', () => {
  it('usuario sin verificar: la contraseña nueva marca emailVerified en la misma transacción (D26)', async () => {
    const antes = Date.now();
    const res = await post({ token: TOKEN, password: 'contrasena-larga' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // El lookup del token trae el estado del usuario (es lo que permite conservar la fecha).
    expect(mocks.tokenFindUnique.mock.calls[0][0].select.user).toEqual({
      select: { emailVerified: true },
    });

    expect(mocks.hash).toHaveBeenCalledWith('contrasena-larga', 12);
    const upd = mocks.userUpdate.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'u-1' });
    expect(upd.data.passwordHash).toBe('$2a$12$hash');
    expect(upd.data.emailVerified).toBeInstanceOf(Date);
    expect(upd.data.emailVerified.getTime()).toBeGreaterThanOrEqual(antes);

    // Todo en una transacción: contraseña, token usado, otros tokens fuera.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0][0]).toHaveLength(3);
    expect(mocks.tokenUpdate.mock.calls[0][0].data.usedAt).toBeInstanceOf(Date);
    expect(mocks.tokenDeleteMany.mock.calls[0][0].where).toMatchObject({
      userId: 'u-1',
      usedAt: null,
      id: { not: 'tok-1' },
    });
  });

  it('usuario ya verificado: se conserva la fecha original', async () => {
    const original = new Date('2026-01-15T12:00:00Z');
    mocks.tokenFindUnique.mockResolvedValueOnce(filaToken({ user: { emailVerified: original } }));
    expect((await post({ token: TOKEN, password: 'contrasena-larga' })).status).toBe(200);
    expect(mocks.userUpdate.mock.calls[0][0].data.emailVerified).toBe(original);
  });

  it('token expirado → 400 genérico y no se toca al usuario', async () => {
    mocks.tokenFindUnique.mockResolvedValueOnce(filaToken({ expiresAt: new Date(Date.now() - 1000) }));
    const res = await post({ token: TOKEN, password: 'contrasena-larga' });
    expect(res.status).toBe(400);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('token ya usado o inexistente → 400, misma respuesta', async () => {
    mocks.tokenFindUnique.mockResolvedValueOnce(filaToken({ usedAt: new Date() }));
    const usado = await post({ token: TOKEN, password: 'contrasena-larga' });
    mocks.tokenFindUnique.mockResolvedValueOnce(null);
    const inexistente = await post({ token: TOKEN, password: 'contrasena-larga' });
    expect(usado.status).toBe(400);
    expect(inexistente.status).toBe(400);
    expect(await usado.json()).toEqual(await inexistente.json());
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('contraseña corta → 400 sin buscar el token', async () => {
    expect((await post({ token: TOKEN, password: 'corta' })).status).toBe(400);
    expect(mocks.tokenFindUnique).not.toHaveBeenCalled();
  });
});
