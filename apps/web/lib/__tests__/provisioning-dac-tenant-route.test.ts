import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.ENCRYPTION_KEY = '88'.repeat(32);
process.env.AUTOENVIA_PROVISION_TOKEN = 'token-de-prueba';

/**
 * POST /api/provisioning/dac-tenant — el alta de un Tenant desde afuera.
 *
 * Lo que se prueba acá es la política, no el CRUD: los dos campos que agregó el
 * 2026-09-05 (`operacion` y `envios`, para las cuentas que opera el depósito)
 * son OPCIONALES, y el punto entero es que sin ellos NADA cambie — el tenant de
 * VentaFlow se aprovisionó por esta misma ruta y tiene que seguir despachando
 * solo cada 15 minutos con su saldo real.
 */
const mocks = vi.hoisted(() => ({
  userUpsert: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantCreate: vi.fn(),
  tenantUpdate: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {
    user: { upsert: mocks.userUpsert },
    tenant: {
      findUnique: mocks.tenantFindUnique,
      create: mocks.tenantCreate,
      update: mocks.tenantUpdate,
    },
  },
}));

import { POST } from '@/app/api/provisioning/dac-tenant/route';

const CUERPO_MINIMO = {
  sellerSlug: 'depo-alba-textil',
  ownerEmail: 'alba@tienda.uy',
  dacUsername: '12345678',
  dacPassword: 'secreta',
  dashboardUrl: 'https://depo-beige.vercel.app',
  dashboardToken: 'depo_token',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userUpsert.mockResolvedValue({ id: 'u-sintetico' });
  mocks.tenantFindUnique.mockResolvedValue(null);
  mocks.tenantCreate.mockResolvedValue({ id: 't-nuevo' });
  mocks.tenantUpdate.mockResolvedValue({ id: 't-nuevo' });
});

function post(body: unknown, token = 'token-de-prueba') {
  return POST(
    new Request('https://autoenvia.com/api/provisioning/dac-tenant', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}

/** Lo que se le pasó a `tenant.create`. */
const datosCreados = () => mocks.tenantCreate.mock.calls[0][0].data;

describe('POST /api/provisioning/dac-tenant', () => {
  it('sin token válido no toca la base', async () => {
    const res = await post(CUERPO_MINIMO, 'otro-token');
    expect(res.status).toBe(401);
    expect(mocks.userUpsert).not.toHaveBeenCalled();
    expect(mocks.tenantCreate).not.toHaveBeenCalled();
  });

  // ── La regresión que hay que evitar ────────────────────────────────────────
  it('sin `operacion` ni `envios` NO escribe cronSchedule ni shipmentCredits', async () => {
    const res = await post(CUERPO_MINIMO);
    expect(res.status).toBe(200);
    const data = datosCreados();
    // Ausentes = Prisma no toca la columna: el default del schema sigue mandando
    // (cron cada 15 minutos, 10 envíos de bienvenida). Es lo que mantiene a
    // VentaFlow despachando sola.
    expect(data).not.toHaveProperty('cronSchedule');
    expect(data).not.toHaveProperty('shipmentCredits');
    expect(data).toMatchObject({ isActive: true, dashboardSourceEnabled: true });
  });

  it('operacion: "manual" deja un cron que el scheduler descarta solo', async () => {
    const res = await post({ ...CUERPO_MINIMO, operacion: 'manual' });
    expect(res.status).toBe(200);
    const cron: string = datosCreados().cronSchedule;
    expect(cron).toBe('manual');
    // La propiedad que de verdad importa, escrita como la evalúa el worker
    // (`apps/worker/src/jobs/scheduler.ts`): menos de 5 campos ⇒ `continue`.
    // Si alguien "arregla" esto poniendo un cron válido, el barrido automático
    // vuelve y estas cuentas empiezan a despachar solas.
    expect(cron.trim().split(/\s+/).length).toBeLessThan(5);
  });

  it('envios: N va a shipmentCredits, y se topea arriba y abajo', async () => {
    await post({ ...CUERPO_MINIMO, envios: 1_000_000_000 });
    expect(datosCreados().shipmentCredits).toBe(1_000_000_000);

    vi.clearAllMocks();
    mocks.userUpsert.mockResolvedValue({ id: 'u-sintetico' });
    mocks.tenantFindUnique.mockResolvedValue(null);
    mocks.tenantCreate.mockResolvedValue({ id: 't-nuevo' });
    // Por encima del int4 de Postgres el insert reventaría con un error de
    // rango que no dice nada: se recorta antes.
    await post({ ...CUERPO_MINIMO, envios: 9_999_999_999 });
    expect(datosCreados().shipmentCredits).toBe(2_000_000_000);

    vi.clearAllMocks();
    mocks.userUpsert.mockResolvedValue({ id: 'u-sintetico' });
    mocks.tenantFindUnique.mockResolvedValue(null);
    mocks.tenantCreate.mockResolvedValue({ id: 't-nuevo' });
    // Negativo no: el gate compara `> 0` y un saldo negativo es un tenant que
    // no despacha nunca sin decir por qué.
    await post({ ...CUERPO_MINIMO, envios: -5 });
    expect(datosCreados().shipmentCredits).toBe(0);
  });

  it('un `envios` que no es entero se ignora en vez de rebotar el alta', async () => {
    const res = await post({ ...CUERPO_MINIMO, envios: 'muchos' });
    expect(res.status).toBe(200);
    expect(datosCreados()).not.toHaveProperty('shipmentCredits');
  });

  it('re-aprovisionar la misma cuenta actualiza en vez de crear otra', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ id: 't-existente', userId: 'u-sintetico' });
    const res = await post({ ...CUERPO_MINIMO, operacion: 'manual', envios: 1_000 });
    expect(res.status).toBe(200);
    expect(mocks.tenantCreate).not.toHaveBeenCalled();
    expect(mocks.tenantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't-existente' },
        data: expect.objectContaining({ cronSchedule: 'manual', shipmentCredits: 1_000 }),
      }),
    );
  });

  // ── Transportista ────────────────────────────────────────────────────────
  // El worker de la fuente dashboard ya sabía despachar por Correo Uruguayo; lo
  // que faltaba era poder dar de alta una cuenta así.
  it('sin `transportista` guarda DAC y NO toca nada de Correo (comportamiento de siempre)', async () => {
    await post(CUERPO_MINIMO);
    const data = datosCreados();
    expect(data.dacUsername).toBeTruthy();
    expect(data.dacPassword).toBeTruthy();
    expect(data).not.toHaveProperty('correoEnabled');
    expect(data).not.toHaveProperty('correoUser');
  });

  it('transportista CORREO guarda Correo y NO guarda DAC', async () => {
    const res = await post({
      ...CUERPO_MINIMO,
      transportista: 'CORREO',
      correoUser: 'usuario-ahiva',
      correoPassword: 'secreta',
      correoCuenta: '12345',
      correoAmbiente: 'prod',
      pesoDefaultKg: 1.5,
    });
    expect(res.status).toBe(200);
    const data = datosCreados();
    expect(data.correoEnabled).toBe(true);
    expect(data.correoAmbiente).toBe('prod');
    expect(data.pesoDefaultKg).toBe(1.5);
    expect(data.correoUser).toBeTruthy();
    // Cargar las dos dejaría un tenant que ningún camino de la UI produce, y el
    // job elige por `correoEnabled`, no por cuál tiene datos.
    expect(data).not.toHaveProperty('dacUsername');
    expect(data).not.toHaveProperty('dacPassword');
  });

  it('CORREO sin peso rebota: Correo lo exige en cada envío', async () => {
    const res = await post({
      ...CUERPO_MINIMO,
      transportista: 'CORREO',
      correoUser: 'u',
      correoPassword: 'p',
    });
    expect(res.status).toBe(400);
    expect(mocks.tenantCreate).not.toHaveBeenCalled();
  });

  it('CORREO sin credenciales rebota, y NO cae al mensaje de DAC', async () => {
    const res = await post({ ...CUERPO_MINIMO, transportista: 'CORREO', pesoDefaultKg: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'faltan credenciales de Correo Uruguayo' });
    expect(mocks.tenantCreate).not.toHaveBeenCalled();
  });

  it('CORREO puede darse de alta SIN credenciales de DAC', async () => {
    // El caso que antes era imposible: una tienda que despacha por Correo no
    // tiene por qué tener cuenta en DAC. El scheduler ya lo aceptaba (su where
    // es un OR entre los dos transportistas); el alta no.
    const { dacUsername: _u, dacPassword: _p, ...sinDac } = CUERPO_MINIMO;
    const res = await post({
      ...sinDac,
      transportista: 'CORREO',
      correoUser: 'u',
      correoPassword: 'p',
      pesoDefaultKg: 2,
    });
    expect(res.status).toBe(200);
    expect(datosCreados().correoEnabled).toBe(true);
  });

  it('el ambiente de Correo cae a "test" salvo que se pida prod explícito', async () => {
    // El catálogo de oficinas difiere entre ambientes: despachar contra el
    // equivocado acepta sucursales que en producción no existen.
    await post({
      ...CUERPO_MINIMO,
      transportista: 'CORREO',
      correoUser: 'u',
      correoPassword: 'p',
      pesoDefaultKg: 1,
      correoAmbiente: 'cualquier-cosa',
    });
    expect(datosCreados().correoAmbiente).toBe('test');
  });

  // ── Contrareembolso ──────────────────────────────────────────────────────
  // El interruptor del tenant nace apagado y el worker descarta en silencio el
  // `cod_amount` del feed si sigue apagado: el origen tiene que poder prenderlo.
  it('codEnabled true se guarda tal cual (DEPO decide el cobro por pedido)', async () => {
    await post({ ...CUERPO_MINIMO, codEnabled: true });
    expect(datosCreados().codEnabled).toBe(true);
  });

  it('codEnabled ausente NO toca la columna: un cuerpo viejo no apaga un cobro que ya andaba', async () => {
    await post(CUERPO_MINIMO);
    expect(datosCreados()).not.toHaveProperty('codEnabled');
  });

  it('codEnabled con un valor que no es booleano se ignora', async () => {
    await post({ ...CUERPO_MINIMO, codEnabled: 'true' });
    expect(datosCreados()).not.toHaveProperty('codEnabled');
  });

  it('codEnabled también aplica al alta de CORREO', async () => {
    await post({
      ...CUERPO_MINIMO,
      transportista: 'CORREO',
      correoUser: 'u',
      correoPassword: 'p',
      pesoDefaultKg: 1,
      codEnabled: true,
    });
    const data = datosCreados();
    expect(data.correoEnabled).toBe(true);
    expect(data.codEnabled).toBe(true);
  });

  it('el slug sale de sellerSlug y es el marcador de las cuentas de DEPO', async () => {
    await post(CUERPO_MINIMO);
    // `ae-depo-*` es lo que agrupa la sección DEPO del Centro de Control
    // (`app/api/v1/control/overview/route.ts`). Si el prefijo cambia, esa
    // sección se vacía sin ningún error.
    expect(datosCreados().slug).toBe('ae-depo-alba-textil');
  });
});
