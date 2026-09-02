import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/auth/verify-email/send — reenvío del mail de verificación.
 * D26: además del 3/h por email, tope diario por email y tope por IP.
 * Prisma, Redis y Resend mockeados; el handler y su orden de chequeos son
 * los de verdad.
 */
const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  getRedis: vi.fn(),
  issueAndSend: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }));
vi.mock('@/lib/redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('@/lib/verify-email', () => ({
  issueAndSendVerificationEmail: mocks.issueAndSend,
  resolveAppOrigin: () => 'https://autoenvia.com',
}));

import { POST } from '@/app/api/auth/verify-email/send/route';

const EMAIL = 'juana@tienda.uy';
const SIN_VERIFICAR = { id: 'u-1', email: EMAIL, name: 'Juana', emailVerified: null };

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('https://autoenvia.com/api/auth/verify-email/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

/**
 * Redis falso: un contador por clave, como INCR de verdad, y un pipeline que
 * devuelve un resultado por comando encolado (forma de ioredis
 * `[[err, valor], ...]`), porque el handler mete dos INCR en una pipeline.
 */
function redisFalso(inicial: Record<string, number> = {}) {
  const counts: Record<string, number> = { ...inicial };
  let cola: Array<() => number> = [];
  const pipeline = {
    incr: vi.fn((key: string) => {
      cola.push(() => (counts[key] = (counts[key] ?? 0) + 1));
      return pipeline;
    }),
    expire: vi.fn(() => {
      cola.push(() => 1);
      return pipeline;
    }),
    exec: vi.fn(async () => {
      const out = cola.map((f) => [null, f()]);
      cola = [];
      return out;
    }),
  };
  mocks.getRedis.mockReturnValue({ pipeline: () => pipeline });
  return { counts, pipeline };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRedis.mockReturnValue(null);
  mocks.userFindUnique.mockResolvedValue(SIN_VERIFICAR);
  mocks.issueAndSend.mockResolvedValue({ issued: true, send: { ok: true, id: 'mail-1' } });
});

describe('POST /api/auth/verify-email/send', () => {
  it('sin Redis (fail-open logueado) reenvía a un usuario sin verificar', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await post({ email: 'Juana@Tienda.UY' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mocks.userFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: EMAIL } }),
      );
      expect(mocks.issueAndSend).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1', email: EMAIL }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sin REDIS_URL'));
    } finally {
      warn.mockRestore();
    }
  });

  it('respuesta constante: usuario inexistente o ya verificado → { ok: true } sin mandar nada', async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    expect(await (await post({ email: EMAIL })).json()).toEqual({ ok: true });
    mocks.userFindUnique.mockResolvedValueOnce({ ...SIN_VERIFICAR, emailVerified: new Date() });
    expect(await (await post({ email: EMAIL })).json()).toEqual({ ok: true });
    expect(mocks.issueAndSend).not.toHaveBeenCalled();
  });

  it('email inválido → 400', async () => {
    expect((await post({ email: 'no-es-un-mail' })).status).toBe(400);
    expect((await post('{roto')).status).toBe(400);
  });

  it('3/h por email: el cuarto en la hora → 429, sin consultar la base', async () => {
    redisFalso({ [`verify-email:rl:${EMAIL}`]: 3 });
    const res = await post({ email: EMAIL });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Esperá una hora/);
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.issueAndSend).not.toHaveBeenCalled();
  });

  it('5/día por email: con la hora fresca pero 5 reenvíos en el día → 429 (D26)', async () => {
    const { counts, pipeline } = redisFalso({ [`verify-email:rl:day:${EMAIL}`]: 5 });
    const res = await post({ email: EMAIL });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/varias veces hoy/);
    expect(pipeline.expire).toHaveBeenCalledWith(`verify-email:rl:day:${EMAIL}`, 24 * 60 * 60);
    expect(counts[`verify-email:rl:day:${EMAIL}`]).toBe(6);
    expect(mocks.issueAndSend).not.toHaveBeenCalled();
  });

  it('5/día: el quinto del día todavía sale', async () => {
    redisFalso({ [`verify-email:rl:day:${EMAIL}`]: 4 });
    expect((await post({ email: EMAIL })).status).toBe(200);
    expect(mocks.issueAndSend).toHaveBeenCalledTimes(1);
  });

  it('20/h por IP: el 21º desde el mismo /64 → 429 y NO gasta los contadores del email (D26)', async () => {
    const { counts, pipeline } = redisFalso({ 'verify-email:rl:ip:2001:db8:85a3:1::/64': 20 });
    const res = await post({ email: EMAIL }, { 'x-forwarded-for': '2001:db8:85a3:1:aaaa:bbbb:cccc:dddd' });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/desde esta red/);
    expect(pipeline.incr).toHaveBeenCalledWith('verify-email:rl:ip:2001:db8:85a3:1::/64');
    expect(counts[`verify-email:rl:${EMAIL}`]).toBeUndefined();
    expect(counts[`verify-email:rl:day:${EMAIL}`]).toBeUndefined();
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });

  it('20/h por IP: el 20º pasa y sí cuenta para el email', async () => {
    const { counts } = redisFalso({ 'verify-email:rl:ip:203.0.113.9': 19 });
    expect((await post({ email: EMAIL }, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })).status).toBe(200);
    expect(counts['verify-email:rl:ip:203.0.113.9']).toBe(20);
    expect(counts[`verify-email:rl:${EMAIL}`]).toBe(1);
    expect(counts[`verify-email:rl:day:${EMAIL}`]).toBe(1);
  });

  it('Redis caído: fail-open con warn, el mail sale igual', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pipeline = {
        incr: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      };
      mocks.getRedis.mockReturnValue({ pipeline: () => pipeline });
      expect((await post({ email: EMAIL })).status).toBe(200);
      expect(mocks.issueAndSend).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('fail-open'),
        expect.objectContaining({ message: 'ECONNRESET' }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
