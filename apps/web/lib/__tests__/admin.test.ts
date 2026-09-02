import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * lib/admin — mecanismo de admin por ADMIN_EMAILS (D32). `isAdminEmail` es
 * puro y lo usa el layout del dashboard para el menú; `requireAdminOrNotFound`
 * es el gate server-side de las páginas sólo-admin.
 */
const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  userFindUnique: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }));

import { isAdminEmail, getAdminSession, requireAdminOrNotFound } from '../admin';

const ORIGINAL = { ADMIN_EMAILS: process.env.ADMIN_EMAILS, ADMIN_EMAIL: process.env.ADMIN_EMAIL };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAIL;
});
afterEach(() => {
  for (const k of ['ADMIN_EMAILS', 'ADMIN_EMAIL'] as const) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

describe('isAdminEmail', () => {
  it('lista vacía → nadie es admin', () => {
    expect(isAdminEmail('adrijk7.cr@gmail.com')).toBe(false);
  });

  it('ADMIN_EMAILS con mayúsculas y espacios: compara normalizado', () => {
    process.env.ADMIN_EMAILS = 'A@x.com, b@y.com ';
    expect(isAdminEmail('a@x.com')).toBe(true);
    expect(isAdminEmail('  B@Y.COM ')).toBe(true);
    expect(isAdminEmail('c@z.com')).toBe(false);
  });

  it('fallback a ADMIN_EMAIL (un solo dueño)', () => {
    process.env.ADMIN_EMAIL = 'solo@x.com';
    expect(isAdminEmail('solo@x.com')).toBe(true);
    expect(isAdminEmail('otro@x.com')).toBe(false);
  });

  it('ADMIN_EMAILS gana sobre ADMIN_EMAIL', () => {
    process.env.ADMIN_EMAILS = 'lista@x.com';
    process.env.ADMIN_EMAIL = 'viejo@x.com';
    expect(isAdminEmail('lista@x.com')).toBe(true);
    expect(isAdminEmail('viejo@x.com')).toBe(false);
  });

  it('null, undefined y vacío → false', () => {
    process.env.ADMIN_EMAILS = 'a@x.com';
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail('')).toBe(false);
  });
});

describe('getAdminSession / requireAdminOrNotFound', () => {
  it('sin sesión → null y 404', async () => {
    mocks.getServerSession.mockResolvedValue(null);
    expect(await getAdminSession()).toBeNull();
    await expect(requireAdminOrNotFound()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it('el email sale de la fila de User, no del token; no-admin → 404', async () => {
    process.env.ADMIN_EMAILS = 'admin@x.com';
    mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', email: 'admin@x.com' } });
    mocks.userFindUnique.mockResolvedValue({ email: 'usuario@x.com' });
    expect(await getAdminSession()).toBeNull();
    await expect(requireAdminOrNotFound()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('admin → devuelve la sesión y no llama notFound', async () => {
    process.env.ADMIN_EMAILS = 'admin@x.com';
    mocks.getServerSession.mockResolvedValue({ user: { id: 'u1' } });
    mocks.userFindUnique.mockResolvedValue({ email: 'Admin@X.com' });
    expect(await requireAdminOrNotFound()).toEqual({ userId: 'u1', email: 'admin@x.com' });
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { email: true } });
  });
});
