/**
 * Requisito 2.3.1 del App Store de Shopify, textual:
 *
 *   «Apps must be installed and initiated only on Shopify services. Your app
 *    must not request the manual entry of a myshopify.com URL or a shop's
 *    domain during the installation or configuration flow.»
 *
 * `shopify-2-3-1-dominio-manual.test.ts` ya cerraba la UI del wizard. El
 * self-review del 16-09-2026 encontró que ese corte era sólo cosmético: quedaban
 * TRES fugas que alcanza un revisor con sesión, que es exactamente quien mira.
 *
 *   1. El asistente de soporte de adentro de la app (ChatWidget, montado para
 *      todo comerciante) le DICTABA el alta manual: dominio de ejemplo, prefijo
 *      del access token y la pantalla de apps personalizadas del admin.
 *   2. /tutorial/shopify-token estaba detrás de SESIÓN, no de admin — el
 *      middleware usa `getToken()`, que no distingue comerciante de operador — y
 *      el 422 de test-shopify devolvía la URL del tutorial servida en bandeja.
 *   3. El backend del alta manual seguía abierto: `POST
 *      /api/v1/onboarding/test-shopify` y `PUT /api/v1/settings` aceptaban
 *      `shopifyStoreUrl` / `shopifyToken` de cualquier tenant logueado.
 *
 * Cada caso de acá falla si se deshace su arreglo. Lo que NO se toca —y tiene
 * su propio caso— es el tenant de producción que ya tiene token: el gate es
 * sobre ESCRIBIR uno nuevo a mano, no sobre usar el que ya existe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

process.env.ENCRYPTION_KEY = '77'.repeat(32);

const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  getControlActor: vi.fn(),
  tenantUpdate: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindUnique: vi.fn(),
  runLogDeleteMany: vi.fn(),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: {
      update: mocks.tenantUpdate,
      findFirst: mocks.tenantFindFirst,
      findUnique: mocks.tenantFindUnique,
    },
    runLog: { deleteMany: mocks.runLogDeleteMany },
  },
}));
// Se mockea el actor, NO el helper: así el gate de verdad
// (`puedeEscribirShopifyAMano`) corre en cada caso.
vi.mock('@/lib/control-scope', () => ({ getControlActor: mocks.getControlActor }));

import { SYSTEM_PROMPT } from '@/lib/chat-system-prompt';
import { POST as testShopify } from '@/app/api/v1/onboarding/test-shopify/route';
import { PUT as settingsPut } from '@/app/api/v1/settings/route';
import { SHOPIFY_MANUAL_BLOQUEADO_MESSAGE } from '@/lib/shopify-manual.server';

const fetchSpy = vi.fn();

/** Comerciante común: es lo que ve el revisor de Shopify cuando se registra. */
function comerciante() {
  mocks.getControlActor.mockResolvedValue({ userId: 'u1', isAdmin: false });
}
/** Adrian operando su propio panel. */
function admin() {
  mocks.getControlActor.mockResolvedValue({ userId: 'u1', isAdmin: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
  mocks.getAuthenticatedTenant.mockResolvedValue({
    userId: 'u1',
    tenantId: 'tenant-1',
    isActive: true,
    subscriptionStatus: 'ACTIVE',
  });
  mocks.tenantUpdate.mockResolvedValue({});
  mocks.tenantFindFirst.mockResolvedValue(null);
  mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: null });
  mocks.runLogDeleteMany.mockResolvedValue({ count: 0 });
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          shop: {
            name: 'Mi Tienda',
            email: 'due@tienda.com',
            myshopifyDomain: 'kinevia.myshopify.com',
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  comerciante();
});
afterEach(() => vi.unstubAllGlobals());

function postTestShopify(body: unknown) {
  return testShopify(
    new Request('https://autoenvia.com/api/v1/onboarding/test-shopify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function putSettings(body: unknown) {
  return settingsPut(
    new NextRequest('https://autoenvia.com/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ───────────────────────── Fuga 1: el asistente de soporte ─────────────────

describe('fuga 1 — el chat de soporte dictaba el alta manual', () => {
  it('no nombra el prefijo de los Admin API token de Shopify', () => {
    expect(SYSTEM_PROMPT).not.toContain('shpat_');
  });

  it('no da un dominio .myshopify.com de ejemplo para tipear', () => {
    expect(SYSTEM_PROMPT).not.toContain('myshopify.com');
  });

  it('no manda a la pantalla de apps personalizadas del admin de Shopify', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/custom apps/i);
    expect(SYSTEM_PROMPT).not.toMatch(/apps? privada/i);
  });

  it('no pide pegar un Access Token ni una Store URL', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/access token/i);
    expect(SYSTEM_PROMPT).not.toMatch(/store url/i);
  });

  it('el comerciante no queda sin respuesta: lo manda al App Store de Shopify', () => {
    // Que no diga nada sería peor que decir de más: el que pregunta «cómo
    // conecto Shopify» tiene que salir del chat sabiendo qué hacer.
    expect(SYSTEM_PROMPT).toMatch(/App Store de Shopify/);
  });
});

// ──────────────── Fuga 2: la URL del tutorial dentro de un error ───────────

describe('fuga 2 — el 422 servía la URL del tutorial', () => {
  it('el token rechazado por Shopify ya no linkea /tutorial/shopify-token', async () => {
    admin(); // hay que pasar el gate para llegar al 422
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await postTestShopify({
      shopifyStoreUrl: 'kinevia.myshopify.com',
      shopifyToken: 'shpat_0123456789',
    });
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).not.toContain('/tutorial');
    // El resto del diagnóstico sigue: el mensaje no se vació, se le sacó el link.
    expect(error).toContain('Alcances');
  });
});

// ─────────── Fuga 3: el backend del alta manual, abierto a cualquiera ──────

describe('fuga 3a — POST /api/v1/onboarding/test-shopify', () => {
  it('un comerciante logueado recibe 403 y NO se le prueba ni se le guarda el token', async () => {
    const res = await postTestShopify({
      shopifyStoreUrl: 'kinevia.myshopify.com',
      shopifyToken: 'shpat_0123456789',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SHOPIFY_MANUAL_BLOQUEADO_MESSAGE });
    // Ni siquiera se habla con Shopify: un token que no se puede aceptar
    // tampoco se parsea ni se prueba.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('el mensaje del 403 no revela que exista un camino manual', async () => {
    const res = await postTestShopify({
      shopifyStoreUrl: 'kinevia.myshopify.com',
      shopifyToken: 'shpat_0123456789',
    });
    const { error } = (await res.json()) as { error: string };
    expect(error).not.toMatch(/token/i);
    expect(error).not.toContain('/tutorial');
  });

  it('un admin sigue pudiendo dar de alta una tienda a mano', async () => {
    admin();
    const res = await postTestShopify({
      shopifyStoreUrl: 'kinevia.myshopify.com',
      shopifyToken: 'shpat_0123456789',
    });
    expect(res.status).toBe(200);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
  });

  it('si no se puede resolver quién llama, apagado (fail-closed)', async () => {
    mocks.getControlActor.mockRejectedValue(new Error('base caída'));
    const res = await postTestShopify({
      shopifyStoreUrl: 'kinevia.myshopify.com',
      shopifyToken: 'shpat_0123456789',
    });
    expect(res.status).toBe(403);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });
});

describe('fuga 3b — PUT /api/v1/settings', () => {
  it('un comerciante no puede pegar un shopifyToken', async () => {
    const res = await putSettings({ shopifyToken: 'shpat_9999999999' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SHOPIFY_MANUAL_BLOQUEADO_MESSAGE });
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('un comerciante tampoco puede escribir el dominio .myshopify.com', async () => {
    const res = await putSettings({ shopifyStoreUrl: 'kinevia.myshopify.com' });
    expect(res.status).toBe(403);
    expect(mocks.tenantUpdate).not.toHaveBeenCalled();
  });

  it('un admin sí: dominio + token se verifican contra Shopify y se guardan', async () => {
    admin();
    const res = await putSettings({
      shopifyStoreUrl: 'kinevia.myshopify.com',
      shopifyToken: 'shpat_9999999999',
    });
    expect(res.status).toBe(200);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 EL CASO QUE PROTEGE A PRODUCCIÓN. Kinevia, TAM, Aura y Enerva despachan
 * HOY con un token cargado por el camino viejo, y ninguno de sus dueños es
 * admin. Si el gate se hubiera puesto sobre el PUT entero —o sobre "el tenant
 * tiene token"— cada uno de esos comerciantes habría dejado de poder guardar
 * su propia configuración. El gate mira SÓLO si el request trae dominio o token
 * nuevo.
 */
describe('los tenants que ya despachan no se tocan', () => {
  it('un comerciante guarda el resto de su configuración igual que siempre', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ shopifyStoreUrl: 'kinevia.myshopify.com' });
    const res = await putSettings({
      maxOrdersPerRun: 20,
      autoFulfillEnabled: true,
      orderSortDirection: 'oldest_first',
    });
    expect(res.status).toBe(200);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.tenantUpdate.mock.calls[0][0].data).toMatchObject({
      maxOrdersPerRun: 20,
      autoFulfillEnabled: true,
    });
  });

  it('un comerciante cambia sus credenciales de DAC sin tocar Shopify', async () => {
    const res = await putSettings({ dacUsername: '12345678', dacPassword: 'secreta' });
    expect(res.status).toBe(200);
    expect(mocks.tenantUpdate).toHaveBeenCalledTimes(1);
    // El token de Shopify que ya tiene no se toca ni se borra.
    expect(mocks.tenantUpdate.mock.calls[0][0].data).not.toHaveProperty('shopifyToken');
    expect(mocks.tenantUpdate.mock.calls[0][0].data).not.toHaveProperty('shopifyStoreUrl');
  });
});
