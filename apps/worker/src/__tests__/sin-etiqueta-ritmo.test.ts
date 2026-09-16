/**
 * El job SIN ETIQUETA respeta el bucket REST de Shopify.
 *
 * LO QUE PASÓ (16-09-2026, dos arranques del worker de Render, 12:35 y 14:43):
 * la pasada de boot sacaba el tag pedido por pedido sin pausa, el bucket de
 * Shopify (40, drena 2/s) se vaciaba (`Shopify rate limit high used=40/40`) y
 * decenas de pedidos de tres tenants terminaban en `[SinEtiqueta] No pude sacar
 * el tag` con `Request failed with status code 429`. Cada boot repetía la
 * tormenta y esos pedidos seguían taggeados.
 *
 * Este test corre el job DE VERDAD — fachada `shopify/index.ts` real,
 * `orders.ts` real (GET + PUT por pedido) — contra un emulador fiel del leaky
 * bucket, con reloj falso. Sólo se reemplaza el axios que fabrica
 * `shopify/client.ts`. Si alguien saca `installShopifyRestPacer` del job,
 * el primer test falla: sin ritmo, el emulador devuelve 429 igual que Shopify.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

const mocks = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  labelFindMany: vi.fn(),
  resolveAccess: vi.fn(),
  tokenSource: vi.fn(),
  createRestClient: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    tenant: { findMany: mocks.tenantFindMany },
    label: { findMany: mocks.labelFindMany },
  },
}));
vi.mock('../logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../shopify/access', () => ({
  resolveShopifyAccessForJob: mocks.resolveAccess,
  shopifyTokenSourceForTenant: mocks.tokenSource,
}));
// Sólo el axios: la fachada y orders.ts son los reales.
vi.mock('../shopify/client', () => ({
  createShopifyClient: mocks.createRestClient,
}));

import { runSinEtiquetaTagging, TAG_SIN_ETIQUETA } from '../jobs/sin-etiqueta-tag.job';
import { _resetShopifyApiMemo } from '../shopify/mode';
import logger from '../logger';

const TENANT = { id: 't1', slug: 'kinevia', shopifyStoreUrl: 'kinevia.myshopify.com', shopifyToken: 'tok' };

function relojFalso() {
  const clock = { t: 0 };
  return {
    now: () => clock.t,
    sleep: vi.fn(async (ms: number) => {
      clock.t += ms;
    }),
  };
}

/**
 * Leaky bucket de Shopify: 40 requests, drena 2/s, lleno → 429 con
 * `Retry-After: 2.0`. Cada pedido responde con el tag puesto, así que
 * `removeOrderTag` hace GET + PUT (2 requests por pedido) y `addOrderTag`
 * también.
 */
function tiendaEmulada(now: () => number) {
  const MAX = 40;
  const TASA = 2;
  let used = 0;
  let ultimo = now();
  const emu = { llamadas: 0, rechazos: 0, tagsPorPedido: new Map<string, string>() };

  const adapter = async (config: InternalAxiosRequestConfig) => {
    const t = now();
    used = Math.max(0, used - ((t - ultimo) / 1000) * TASA);
    ultimo = t;
    emu.llamadas += 1;
    if (used + 1 > MAX + 1e-9) {
      emu.rechazos += 1;
      throw new AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', config, null, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'x-shopify-shop-api-call-limit': `${MAX}/${MAX}`, 'retry-after': '2.0' },
        data: { errors: 'Exceeded 2 calls per second for api client. Reduce request rates to resume uninterrupted service.' },
        config,
      });
    }
    used += 1;
    const id = /\/orders\/(\d+)\.json/.exec(config.url ?? '')?.[1] ?? '?';
    const headers = { 'x-shopify-shop-api-call-limit': `${Math.ceil(used)}/${MAX}` };
    if (config.method === 'put') {
      const body = JSON.parse(String(config.data));
      emu.tagsPorPedido.set(id, body.order.tags);
      return { data: { order: body.order }, status: 200, statusText: 'OK', headers, config };
    }
    const tags = emu.tagsPorPedido.get(id) ?? `${TAG_SIN_ETIQUETA}, otra`;
    return { data: { order: { id: Number(id), tags } }, status: 200, statusText: 'OK', headers, config };
  };

  const fabricar = (): AxiosInstance => {
    const rest = axios.create({ baseURL: 'https://kinevia.myshopify.com/admin/api/2024-01' });
    rest.defaults.adapter = adapter;
    return rest;
  };
  return { fabricar, emu };
}

function recuperadas(n: number) {
  const base = new Date('2026-09-10T10:00:00Z');
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    shopifyOrderId: String(1000 + i),
    shopifyOrderName: `#${1000 + i}`,
    createdAt: base,
    updatedAt: new Date(base.getTime() + 2 * 3600_000),
  }));
}

function rotas(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    shopifyOrderId: String(5000 + i),
    shopifyOrderName: `#${5000 + i}`,
  }));
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  _resetShopifyApiMemo();
  delete process.env.SHOPIFY_API_MODE;
  mocks.tenantFindMany.mockResolvedValue([TENANT]);
  mocks.resolveAccess.mockResolvedValue({ access: 'tok', legacy: true });
  mocks.tokenSource.mockReturnValue('tok');
});

describe('la tormenta del boot', () => {
  it('🔴 60 pedidos recuperados (120 requests) contra un bucket de 40: cero 429, todos destaggeados', async () => {
    const reloj = relojFalso();
    const tienda = tiendaEmulada(reloj.now);
    mocks.createRestClient.mockImplementation(tienda.fabricar);
    mocks.labelFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(recuperadas(60));

    const r = await runSinEtiquetaTagging(new Date('2026-09-16T12:35:00Z'), {
      ritmo: { sleep: reloj.sleep, now: reloj.now },
    });

    expect(tienda.emu.rechazos).toBe(0);
    expect(r.errores).toBe(0);
    expect(r.destaggeados).toBe(60);
    expect(tienda.emu.llamadas).toBe(120); // GET + PUT por pedido, ninguna repetida
    expect(reloj.sleep).toHaveBeenCalled(); // no fue suerte: el job frenó
    // Shopify quedó sin el tag en los 60.
    for (const [, tags] of tienda.emu.tagsPorPedido) expect(tags).not.toContain(TAG_SIN_ETIQUETA);
    // Y el log de la corrida dice cuánto frenó: es lo que se mira en Render después del deploy.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ destaggeados: 60, errores: 0, esperas: reloj.sleep.mock.calls.length, reintentos429: 0 }),
      '[SinEtiqueta] Corrida terminada',
    );
  });

  it('el control: el mismo emulador SIN ritmo devuelve 429 (lo que se veía en Render)', async () => {
    const reloj = relojFalso();
    const tienda = tiendaEmulada(reloj.now);
    const rest = tienda.fabricar();
    let fallos = 0;
    for (let i = 0; i < 120; i++) {
      await rest.get(`/orders/${i}.json`).catch((e: AxiosError) => {
        expect(e.response?.status).toBe(429);
        fallos += 1;
      });
    }
    expect(fallos).toBeGreaterThan(0);
    expect(tienda.emu.rechazos).toBe(fallos);
  });

  it('taggear las rotas también va con ritmo (40 rotas + 60 recuperadas = 200 requests)', async () => {
    const reloj = relojFalso();
    const tienda = tiendaEmulada(reloj.now);
    mocks.createRestClient.mockImplementation(tienda.fabricar);
    mocks.labelFindMany.mockResolvedValueOnce(rotas(40)).mockResolvedValueOnce(recuperadas(60));

    const r = await runSinEtiquetaTagging(new Date(), { ritmo: { sleep: reloj.sleep, now: reloj.now } });

    expect(tienda.emu.rechazos).toBe(0);
    expect(r.errores).toBe(0);
    expect(r.taggeados).toBe(40);
    expect(r.destaggeados).toBe(60);
    expect(tienda.emu.llamadas).toBe(200);
  });

  it('un 429 suelto se reintenta respetando Retry-After y el pedido NO cuenta como error', async () => {
    const reloj = relojFalso();
    const tienda = tiendaEmulada(reloj.now);
    // Otro proceso (el despacho) dejó el bucket lleno justo antes de que arranque el job.
    const ajeno = tienda.fabricar();
    for (let i = 0; i < 40; i++) await ajeno.get(`/orders/${i}.json`);

    mocks.createRestClient.mockImplementation(tienda.fabricar);
    mocks.labelFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(recuperadas(3));

    const r = await runSinEtiquetaTagging(new Date(), { ritmo: { sleep: reloj.sleep, now: reloj.now } });

    // El primer GET del job come el 429 (el pacer todavía no había leído ningún header)...
    expect(tienda.emu.rechazos).toBe(1);
    // ...pero se reintenta y los 3 pedidos salen bien.
    expect(r.errores).toBe(0);
    expect(r.destaggeados).toBe(3);
    expect(reloj.sleep.mock.calls[0][0]).toBe(2000); // Retry-After: 2.0
  });

  it('el ritmo es por tienda: cada tenant estrena su bucket', async () => {
    const reloj = relojFalso();
    const a = tiendaEmulada(reloj.now);
    const b = tiendaEmulada(reloj.now);
    mocks.tenantFindMany.mockResolvedValue([TENANT, { ...TENANT, id: 't2', slug: 'tam', shopifyStoreUrl: 'tam.myshopify.com' }]);
    mocks.createRestClient.mockImplementationOnce(a.fabricar).mockImplementationOnce(b.fabricar);
    mocks.labelFindMany
      .mockResolvedValueOnce([]).mockResolvedValueOnce(recuperadas(50))
      .mockResolvedValueOnce([]).mockResolvedValueOnce(recuperadas(50));

    const r = await runSinEtiquetaTagging(new Date(), { ritmo: { sleep: reloj.sleep, now: reloj.now } });

    expect(a.emu.rechazos + b.emu.rechazos).toBe(0);
    expect(r.destaggeados).toBe(100);
    expect(r.errores).toBe(0);
  });
});

describe('lo que NO cambia', () => {
  it('🔴 el predicado sigue siendo el status, no pdfPath a secas', async () => {
    const reloj = relojFalso();
    mocks.createRestClient.mockImplementation(tiendaEmulada(reloj.now).fabricar);
    mocks.labelFindMany.mockResolvedValue([]);
    await runSinEtiquetaTagging(new Date(), { ritmo: { sleep: reloj.sleep, now: reloj.now } });
    const where = mocks.labelFindMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['FAILED', 'NEEDS_REVIEW'] });
    expect(where.dacGuia).toEqual({ not: null });
    expect(where.pdfPath).toBeNull();
  });

  it('sin trabajo no fabrica cliente ni habla con Shopify', async () => {
    mocks.labelFindMany.mockResolvedValue([]);
    await runSinEtiquetaTagging();
    expect(mocks.createRestClient).not.toHaveBeenCalled();
  });
});
