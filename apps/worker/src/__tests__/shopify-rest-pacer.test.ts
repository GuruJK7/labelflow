/**
 * Ritmo del cliente REST de Shopify (`shopify/rest-pacer.ts`).
 *
 * Se prueba contra un emulador del leaky bucket real (40 requests, drena 2/s,
 * 429 + `Retry-After: 2.0` cuando está lleno — los números de la doc) con un
 * reloj falso: `sleep` avanza el reloj en vez de dormir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

vi.mock('../logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  installShopifyRestPacer,
  esperaParaEntrarMs,
  parseCallLimit,
  parseRetryAfterMs,
  drenajePorSegundo,
} from '../shopify/rest-pacer';

function relojFalso() {
  const clock = { t: 0 };
  return {
    now: () => clock.t,
    sleep: vi.fn(async (ms: number) => {
      clock.t += ms;
    }),
    avanzar: (ms: number) => {
      clock.t += ms;
    },
  };
}

interface EmuladorOpts {
  max?: number;
  tasa?: number;
  now: () => number;
  /** Por defecto manda `Retry-After: 2.0` en los 429, como Shopify. */
  retryAfter?: string | null;
  /** Por defecto manda el header de límite también en los 429. */
  headerEnEl429?: boolean;
}

/** Leaky bucket de Shopify: `used` drena `tasa`/s; lleno → 429. */
function bucketShopify(opts: EmuladorOpts) {
  const max = opts.max ?? 40;
  const tasa = opts.tasa ?? 2;
  let used = 0;
  let ultimo = opts.now();
  const emu = { llamadas: 0, rechazos: 0, cuerpos: [] as unknown[], metodos: [] as string[] };

  const adapter = async (config: InternalAxiosRequestConfig) => {
    const t = opts.now();
    used = Math.max(0, used - ((t - ultimo) / 1000) * tasa);
    ultimo = t;
    emu.llamadas += 1;
    emu.metodos.push(`${config.method?.toUpperCase()} ${config.url}`);
    if (config.data !== undefined) emu.cuerpos.push(config.data);

    if (used + 1 > max + 1e-9) {
      emu.rechazos += 1;
      const headers: Record<string, string> = {};
      if (opts.headerEnEl429 ?? true) headers['x-shopify-shop-api-call-limit'] = `${max}/${max}`;
      if (opts.retryAfter !== null) headers['retry-after'] = opts.retryAfter ?? '2.0';
      throw new AxiosError(
        'Request failed with status code 429',
        'ERR_BAD_REQUEST',
        config,
        null,
        { status: 429, statusText: 'Too Many Requests', headers, data: { errors: 'Exceeded 2 calls per second for api client' }, config },
      );
    }
    used += 1;
    return {
      data: { order: { id: 1, tags: 'SIN ETIQUETA, otra' } },
      status: 200,
      statusText: 'OK',
      headers: { 'x-shopify-shop-api-call-limit': `${Math.ceil(used)}/${max}` },
      config,
    };
  };
  return { adapter, emu };
}

function clienteConEmulador(opts: EmuladorOpts): { rest: AxiosInstance; emu: ReturnType<typeof bucketShopify>['emu'] } {
  const rest = axios.create({ baseURL: 'https://x.myshopify.com/admin/api/2024-01' });
  const { adapter, emu } = bucketShopify(opts);
  rest.defaults.adapter = adapter;
  return { rest, emu };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('los parsers', () => {
  it('lee "32/40" y rechaza basura', () => {
    expect(parseCallLimit('32/40')).toEqual({ used: 32, max: 40 });
    expect(parseCallLimit('40/40')).toEqual({ used: 40, max: 40 });
    expect(parseCallLimit(undefined)).toBeNull();
    expect(parseCallLimit('')).toBeNull();
    expect(parseCallLimit('x/40')).toBeNull();
    expect(parseCallLimit('3/0')).toBeNull();
    expect(parseCallLimit(32)).toBeNull();
  });

  it('Retry-After viene en segundos con decimales ("2.0") y se pasa a ms', () => {
    expect(parseRetryAfterMs('2.0')).toBe(2000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(3)).toBe(3000);
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfterMs('-1')).toBeNull();
  });

  it('asume la tasa MÁS LENTA para cada tamaño de bucket (Advanced comparte el 40)', () => {
    expect(drenajePorSegundo(40)).toBe(2); // standard 2/s, Advanced 4/s → asumimos 2
    expect(drenajePorSegundo(400)).toBe(20); // Plus
    expect(drenajePorSegundo(1)).toBe(2);
  });
});

describe('esperaParaEntrarMs — cuánto dormir antes de la próxima request', () => {
  it('sin lectura previa no espera (la primera request trae el header)', () => {
    expect(esperaParaEntrarMs(null, 0, 0.25, 0)).toBe(0);
  });

  it('con lugar hasta el umbral (30 de 40) no espera', () => {
    expect(esperaParaEntrarMs({ used: 29, max: 40, at: 0 }, 0, 0.25, 0)).toBe(0);
    expect(esperaParaEntrarMs({ used: 30, max: 40, at: 0 }, 0, 0.25, 0)).toBe(500); // 31 > 30 → medio segundo
  });

  it('con el bucket lleno espera lo que tarda en drenar hasta el umbral', () => {
    // 40/40 recién leído: proyectado 41, umbral 30 → 11 requests a 2/s = 5,5 s
    expect(esperaParaEntrarMs({ used: 40, max: 40, at: 0 }, 0, 0.25, 0)).toBe(5500);
  });

  it('descuenta lo que drenó desde la lectura', () => {
    // 40/40 leído hace 5 s → drenó 10 → 30 → proyectado 31 → 0,5 s
    expect(esperaParaEntrarMs({ used: 40, max: 40, at: 0 }, 0, 0.25, 5000)).toBe(500);
    // hace 6 s → 28 → entra sin esperar
    expect(esperaParaEntrarMs({ used: 40, max: 40, at: 0 }, 0, 0.25, 6000)).toBe(0);
  });

  it('cuenta las requests en vuelo', () => {
    expect(esperaParaEntrarMs({ used: 25, max: 40, at: 0 }, 5, 0.25, 0)).toBe(500); // 25+5+1 = 31
  });

  it('Plus (400) drena a 20/s', () => {
    // 400/400: proyectado 401, umbral 300 → 101/20 = 5,05 s → 5050
    expect(esperaParaEntrarMs({ used: 400, max: 400, at: 0 }, 0, 0.25, 0)).toBe(5050);
  });

  it('el reloj nunca resta: un now anterior a la lectura cuenta como 0 drenado', () => {
    expect(esperaParaEntrarMs({ used: 40, max: 40, at: 10_000 }, 0, 0.25, 0)).toBe(5500);
  });
});

describe('instalado sobre un axios contra el bucket emulado', () => {
  it('🔴 80 requests seguidas: sin ritmo comen 429, con ritmo ninguna', async () => {
    const reloj = relojFalso();

    // Control: el mismo emulador, sin pacer.
    const sinRitmo = clienteConEmulador({ now: reloj.now });
    let fallos = 0;
    for (let i = 0; i < 80; i++) {
      await sinRitmo.rest.get(`/orders/${i}.json`).catch(() => (fallos += 1));
    }
    expect(fallos).toBeGreaterThan(0);
    expect(sinRitmo.emu.rechazos).toBe(fallos);

    // Con pacer: mismo bucket, cero 429.
    const conRitmo = clienteConEmulador({ now: reloj.now });
    const pacer = installShopifyRestPacer(conRitmo.rest, { sleep: reloj.sleep, now: reloj.now });
    for (let i = 0; i < 80; i++) {
      await conRitmo.rest.get(`/orders/${i}.json`);
    }
    expect(conRitmo.emu.rechazos).toBe(0);
    expect(conRitmo.emu.llamadas).toBe(80);
    expect(pacer.esperas).toBeGreaterThan(0);
    expect(pacer.reintentos).toBe(0);
    expect(pacer.bucket()?.max).toBe(40);
  });

  it('deja libre la reserva: nunca pasa de 30/40 en el header', async () => {
    const reloj = relojFalso();
    const { rest, emu } = clienteConEmulador({ now: reloj.now });
    const usados: number[] = [];
    rest.interceptors.response.use((r) => {
      usados.push(Number(String(r.headers['x-shopify-shop-api-call-limit']).split('/')[0]));
      return r;
    });
    installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });
    for (let i = 0; i < 60; i++) await rest.get(`/orders/${i}.json`);
    expect(Math.max(...usados)).toBeLessThanOrEqual(30);
    expect(emu.rechazos).toBe(0);
  });

  it('ante 429 duerme Retry-After y re-emite la misma request', async () => {
    const reloj = relojFalso();
    const rest = axios.create({ baseURL: 'https://x.myshopify.com/admin/api/2024-01' });
    let llamadas = 0;
    rest.defaults.adapter = async (config) => {
      llamadas += 1;
      if (llamadas === 1) {
        throw new AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', config, null, {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'x-shopify-shop-api-call-limit': '40/40', 'retry-after': '2.0' },
          data: {},
          config,
        });
      }
      return { data: { ok: true, intento: llamadas }, status: 200, statusText: 'OK', headers: { 'x-shopify-shop-api-call-limit': '1/40' }, config };
    };
    const pacer = installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });

    const { data } = await rest.put('/orders/7.json', { order: { id: 7, tags: 'a, b' } });

    expect(data).toEqual({ ok: true, intento: 2 });
    expect(pacer.reintentos).toBe(1);
    // Primero durmió exactamente Retry-After...
    expect(reloj.sleep.mock.calls[0][0]).toBe(2000);
    // ...y después, como el bucket estaba lleno, la admisión esperó lo suyo antes de reintentar.
    expect(reloj.sleep.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('el reintento conserva método, URL y cuerpo del PUT', async () => {
    const reloj = relojFalso();
    const { rest, emu } = clienteConEmulador({ now: reloj.now });
    installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });
    // Llenamos el bucket a mano sin pasar por el pacer: 40 requests "de otro".
    for (let i = 0; i < 40; i++) {
      await axios.create({ adapter: rest.defaults.adapter }).get('/x');
    }
    // El pacer todavía no leyó ningún header (esas no pasaron por él): la primera va y come 429.
    const cuerpo = { order: { id: 9, tags: 'quedan' } };
    await rest.put('/orders/9.json', cuerpo);
    expect(emu.rechazos).toBe(1);
    const puts = emu.metodos.filter((m) => m === 'PUT /orders/9.json');
    expect(puts).toHaveLength(2);
    expect(emu.cuerpos.map((c) => JSON.parse(String(c)))).toEqual([cuerpo, cuerpo]);
  });

  it('sin Retry-After usa backoff exponencial', async () => {
    const reloj = relojFalso();
    const rest = axios.create();
    let llamadas = 0;
    rest.defaults.adapter = async (config) => {
      llamadas += 1;
      if (llamadas <= 2) {
        throw new AxiosError('429', 'ERR_BAD_REQUEST', config, null, { status: 429, statusText: '', headers: {}, data: {}, config });
      }
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    const pacer = installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });
    await rest.get('/x');
    expect(pacer.reintentos).toBe(2);
    const duermes = reloj.sleep.mock.calls.map((c) => c[0]);
    expect(duermes).toContain(1000);
    expect(duermes).toContain(2000);
  });

  it('agotados los reintentos, el 429 sube tal cual (el job lo cuenta como error)', async () => {
    const reloj = relojFalso();
    const rest = axios.create();
    let llamadas = 0;
    rest.defaults.adapter = async (config) => {
      llamadas += 1;
      throw new AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', config, null, {
        status: 429, statusText: '', headers: { 'retry-after': '1.0' }, data: {}, config,
      });
    };
    const pacer = installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now, maxRetries: 2 });
    await expect(rest.get('/x')).rejects.toMatchObject({ response: { status: 429 } });
    expect(llamadas).toBe(3); // original + 2 reintentos
    expect(pacer.reintentos).toBe(2);
  });

  it('un error que no es 429 sube sin dormir ni reintentar', async () => {
    const reloj = relojFalso();
    const rest = axios.create();
    let llamadas = 0;
    rest.defaults.adapter = async (config) => {
      llamadas += 1;
      throw new AxiosError('404', 'ERR_BAD_REQUEST', config, null, { status: 404, statusText: '', headers: {}, data: {}, config });
    };
    installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });
    await expect(rest.get('/x')).rejects.toMatchObject({ response: { status: 404 } });
    expect(llamadas).toBe(1);
    expect(reloj.sleep).not.toHaveBeenCalled();
  });

  it('un error de red (sin response) sube sin tocar nada', async () => {
    const reloj = relojFalso();
    const rest = axios.create();
    rest.defaults.adapter = async (config) => {
      throw new AxiosError('socket hang up', 'ECONNRESET', config);
    };
    installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });
    await expect(rest.get('/x')).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(reloj.sleep).not.toHaveBeenCalled();
  });

  it('las esperas se topean en maxWaitMs', async () => {
    const reloj = relojFalso();
    const rest = axios.create();
    let llamadas = 0;
    rest.defaults.adapter = async (config) => {
      llamadas += 1;
      if (llamadas === 1) {
        throw new AxiosError('429', 'ERR_BAD_REQUEST', config, null, {
          status: 429, statusText: '', headers: { 'retry-after': '600' }, data: {}, config,
        });
      }
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now, maxWaitMs: 5000 });
    await rest.get('/x');
    expect(Math.max(...reloj.sleep.mock.calls.map((c) => c[0]))).toBeLessThanOrEqual(5000);
  });

  it('lee los headers también cuando vienen como AxiosHeaders (producción)', async () => {
    const reloj = relojFalso();
    const rest = axios.create();
    rest.defaults.adapter = async (config) => ({
      data: {},
      status: 200,
      statusText: 'OK',
      headers: new axios.AxiosHeaders({ 'X-Shopify-Shop-Api-Call-Limit': '12/40' }),
      config,
    });
    const pacer = installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });
    await rest.get('/x');
    expect(pacer.bucket()).toEqual({ used: 12, max: 40, at: 0 });
  });

  it('requests concurrentes entran de a una y no vacían el bucket', async () => {
    const reloj = relojFalso();
    const { rest, emu } = clienteConEmulador({ now: reloj.now });
    installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });
    await Promise.all(Array.from({ length: 60 }, (_, i) => rest.get(`/orders/${i}.json`)));
    expect(emu.rechazos).toBe(0);
    expect(emu.llamadas).toBe(60);
  });

  it('no interfiere con un interceptor de token registrado antes (el del cliente REST)', async () => {
    const reloj = relojFalso();
    const rest = axios.create();
    const vistos: string[] = [];
    rest.interceptors.request.use(async (config) => {
      config.headers.set('X-Shopify-Access-Token', 'shpat_vivo');
      return config;
    });
    rest.defaults.adapter = async (config) => {
      vistos.push(String(config.headers.get('X-Shopify-Access-Token')));
      return { data: {}, status: 200, statusText: 'OK', headers: { 'x-shopify-shop-api-call-limit': '40/40' }, config };
    };
    installShopifyRestPacer(rest, { sleep: reloj.sleep, now: reloj.now });
    await rest.get('/a');
    await rest.get('/b'); // ésta espera por el 40/40
    expect(vistos).toEqual(['shpat_vivo', 'shpat_vivo']);
    expect(reloj.sleep).toHaveBeenCalledTimes(1);
  });
});
