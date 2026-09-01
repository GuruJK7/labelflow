import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * POST /api/auth/signup — alta pública (D22) y anti-abuso mínimo (D24).
 *
 * Todo lo externo está mockeado: Prisma, bcrypt (el hash con cost 12 tarda
 * ~250 ms y acá no probamos bcrypt), Resend, PostHog y Redis. Lo que sí se
 * ejecuta es el handler de verdad, con su zod y su orden de chequeos.
 */

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  tenantFindUnique: vi.fn(),
  nuevoTenantBase: vi.fn(),
  issueAndSend: vi.fn(),
  trackServer: vi.fn(),
  getRedis: vi.fn(),
  hash: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mocks.userFindUnique, create: mocks.userCreate },
    tenant: { findUnique: mocks.tenantFindUnique },
  },
}));
vi.mock('@/lib/tenant-provision', () => ({ nuevoTenantBase: mocks.nuevoTenantBase }));
vi.mock('@/lib/verify-email', () => ({
  issueAndSendVerificationEmail: mocks.issueAndSend,
  resolveAppOrigin: () => 'https://autoenvia.com',
}));
vi.mock('@/lib/analytics.server', () => ({ trackServer: mocks.trackServer }));
vi.mock('@/lib/redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }));

import { POST } from '@/app/api/auth/signup/route';

const BODY_OK = {
  name: 'Juana',
  email: 'juana@tienda.uy',
  password: 'contrasena-larga',
  tosAccepted: true,
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('https://autoenvia.com/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const ORIGINAL_FLAG = process.env.ALLOW_PUBLIC_SIGNUP;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ALLOW_PUBLIC_SIGNUP = 'true';
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.userCreate.mockImplementation(async (args: { data: { email: string; name: string } }) => ({
    id: 'u-1',
    email: args.data.email,
    name: args.data.name,
    tenants: [{ id: 't-1' }],
  }));
  mocks.tenantFindUnique.mockResolvedValue(null);
  mocks.nuevoTenantBase.mockResolvedValue({ apiKey: 'k'.repeat(64), referralCode: 'JU-ABCD' });
  mocks.issueAndSend.mockResolvedValue({ issued: true, send: { ok: true, id: 'mail-1' } });
  mocks.trackServer.mockResolvedValue(undefined);
  mocks.getRedis.mockReturnValue(null);
  mocks.hash.mockResolvedValue('$2a$12$hash');
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ALLOW_PUBLIC_SIGNUP;
  else process.env.ALLOW_PUBLIC_SIGNUP = ORIGINAL_FLAG;
});

describe('POST /api/auth/signup', () => {
  it('con ALLOW_PUBLIC_SIGNUP apagada devuelve 403 sin leer el body ni tocar la base', async () => {
    delete process.env.ALLOW_PUBLIC_SIGNUP;
    const res = await post(BODY_OK);
    expect(res.status).toBe(403);
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('con la bandera en cualquier cosa que no sea "true" sigue cerrado', async () => {
    process.env.ALLOW_PUBLIC_SIGNUP = '1';
    expect((await post(BODY_OK)).status).toBe(403);
  });

  it('camino feliz: 201, guarda el email tal cual y manda el mail de verificación', async () => {
    const res = await post(BODY_OK);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.data).toEqual({ userId: 'u-1', tenantId: 't-1' });
    expect(mocks.hash).toHaveBeenCalledWith('contrasena-larga', 12);
    expect(mocks.issueAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', email: 'juana@tienda.uy' }),
    );
    // tos + IP quedan registrados en el tenant (Ley 18.331)
    const tenant = mocks.userCreate.mock.calls[0][0].data.tenants.create[0];
    expect(tenant.tosAcceptedAt).toBeInstanceOf(Date);
    expect(tenant.referralBonusCredits).toBe(0);
  });

  it('body inválido (contraseña corta) → 400 "Datos inválidos" sin crear nada', async () => {
    const res = await post({ ...BODY_OK, password: 'corta' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Datos inválidos');
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('sin aceptar los términos → 400 con el mensaje de los términos', async () => {
    const res = await post({ ...BODY_OK, tosAccepted: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Términos de Servicio/);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('JSON roto → 400, no 500', async () => {
    const res = await post('{no es json');
    expect(res.status).toBe(400);
  });

  it('honeypot con valor → 200 con forma de éxito y NADA en la base', async () => {
    const res = await post({ ...BODY_OK, website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.issueAndSend).not.toHaveBeenCalled();
  });

  it('honeypot vacío (el form lo manda siempre) no molesta', async () => {
    const res = await post({ ...BODY_OK, website: '' });
    expect(res.status).toBe(201);
  });

  it('email en mayúsculas y con espacios en los bordes se busca y se guarda en minúsculas', async () => {
    const res = await post({ ...BODY_OK, email: '  Juana@Tienda.UY ' });
    expect(res.status).toBe(201);
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { email: 'juana@tienda.uy' } });
    expect(mocks.userCreate.mock.calls[0][0].data.email).toBe('juana@tienda.uy');
  });

  it('email con espacio adentro → 400', async () => {
    const res = await post({ ...BODY_OK, email: 'jua na@tienda.uy' });
    expect(res.status).toBe(400);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('mismo email dos veces → 409 con mensaje que dice qué hacer', async () => {
    expect((await post(BODY_OK)).status).toBe(201);
    mocks.userFindUnique.mockResolvedValueOnce({ id: 'u-1', email: 'juana@tienda.uy' });
    const res = await post({ ...BODY_OK, email: 'JUANA@tienda.uy' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Ya existe una cuenta con ese email/);
    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
  });

  it('carrera: el índice único (P2002) también termina en 409, no en 500', async () => {
    mocks.userCreate.mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
    const res = await post(BODY_OK);
    expect(res.status).toBe(409);
  });

  it('rate limit por IP: el sexto intento en la hora → 429', async () => {
    const exec = vi.fn();
    const pipeline = { incr: vi.fn().mockReturnThis(), expire: vi.fn().mockReturnThis(), exec };
    mocks.getRedis.mockReturnValue({ pipeline: () => pipeline });

    exec.mockResolvedValueOnce([[null, 5], [null, 1]]);
    expect((await post(BODY_OK, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })).status).toBe(201);

    exec.mockResolvedValueOnce([[null, 6], [null, 1]]);
    const res = await post(BODY_OK, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
    expect(res.status).toBe(429);
    expect(pipeline.incr).toHaveBeenLastCalledWith('signup:rl:ip:203.0.113.9');
    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
  });

  it('rate limit fail-open: sin Redis o con Redis roto no se bloquea a nadie', async () => {
    const pipeline = {
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    };
    mocks.getRedis.mockReturnValue({ pipeline: () => pipeline });
    expect((await post(BODY_OK)).status).toBe(201);
  });

  it('el mail que no sale no rompe el alta: 201 igual y no se marca como enviado', async () => {
    mocks.issueAndSend.mockResolvedValueOnce({ issued: true, send: { ok: false, reason: 'no_api_key' } });
    const res = await post(BODY_OK);
    expect(res.status).toBe(201);
    const eventos = mocks.trackServer.mock.calls.map((c) => c[1]);
    expect(eventos).toContain('signup_completed');
    expect(eventos).not.toContain('email_verification_sent');
  });
});
