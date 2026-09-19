/**
 * 🔴 POR QUÉ ESTE TEST. `POST /api/auth/password-reset/request` ignoraba a
 * todo usuario sin `passwordHash` como si fuera una cuenta de Google. Pero
 * las cuentas que crea la instalación desde el Shopify App Store nacen sin
 * contraseña y sin cuenta OAuth: para ellas «¿La olvidaste?» era un no-op
 * silencioso — la pantalla decía «revisá tu mail» y no salía nada. Si el mail
 * de bienvenida se perdía, no había ningún camino para entrar.
 *
 * La respuesta es SIEMPRE `{ ok: true }` (anti-enumeración): lo que se prueba
 * es a quién se le manda el mail de verdad.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ userFindUnique: vi.fn(), enviar: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }));
vi.mock('@/lib/redis', () => ({ getRedis: () => null })); // sin Redis: el rate limit falla abierto
vi.mock('@/lib/password-reset', () => ({ issueAndSendPasswordResetEmail: mocks.enviar }));
vi.mock('@/lib/verify-email', () => ({ resolveAppOrigin: () => 'https://autoenvia.com' }));

import { POST } from '@/app/api/auth/password-reset/request/route';

function pedir(email: string) {
  return POST(
    new Request('https://autoenvia.com/api/auth/password-reset/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enviar.mockResolvedValue({ issued: true, send: null });
});

describe('POST /api/auth/password-reset/request', () => {
  it('usuario con contraseña → manda el mail', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'u1', email: 'a@x.com', name: 'A', passwordHash: '$2b$x', accounts: [] });
    const res = await pedir('a@x.com');
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    expect(mocks.enviar.mock.calls[0][0].userId).toBe('u1');
  });

  it('🔴 cuenta creada por el App Store (sin contraseña, sin OAuth) → TAMBIÉN manda el mail', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'u2', email: 'tienda@x.com', name: 'Tienda', passwordHash: null, accounts: [] });
    const res = await pedir('tienda@x.com');
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    expect(mocks.enviar.mock.calls[0][0].userId).toBe('u2');
  });

  it('cuenta sólo-OAuth (Google, sin contraseña) → sigue sin mandar nada', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'u3', email: 'g@x.com', name: 'G', passwordHash: null, accounts: [{ id: 'acc1' }] });
    const res = await pedir('g@x.com');
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });

  it('usuario inexistente → misma respuesta, sin mail', async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    const res = await pedir('nadie@x.com');
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });

  it('la consulta pide las cuentas OAuth, que es lo que distingue Google del App Store', async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    await pedir('a@x.com');
    expect(mocks.userFindUnique.mock.calls[0][0].select).toMatchObject({ passwordHash: true, accounts: { take: 1 } });
  });
});
