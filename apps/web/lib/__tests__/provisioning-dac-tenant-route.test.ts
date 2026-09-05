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

  it('el slug sale de sellerSlug y es el marcador de las cuentas de DEPO', async () => {
    await post(CUERPO_MINIMO);
    // `ae-depo-*` es lo que agrupa la sección DEPO del Centro de Control
    // (`app/api/v1/control/overview/route.ts`). Si el prefijo cambia, esa
    // sección se vacía sin ningún error.
    expect(datosCreados().slug).toBe('ae-depo-alba-textil');
  });
});
