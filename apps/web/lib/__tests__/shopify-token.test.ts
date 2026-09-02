import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ENCRYPTION_KEY = '55'.repeat(32);

import {
  parseShopifyCredential,
  serializeShopifyCredential,
  credentialFromTokenResponse,
  isExpiringSoon,
  refreshShopifyCredential,
  getValidShopifyAccessToken,
  resolveShopifyAccessToken,
  ShopifyRefreshInvalidGrant,
  ShopifyRefreshTransient,
  ShopifyRefreshError,
  SHOPIFY_TOKEN_REINSTALL_MESSAGE,
  SHOPIFY_TOKEN_JOB_SKEW_MS,
  SHOPIFY_TOKEN_RACE_GRACE_MS,
  __resetShopifyTokenState,
  type ShopifyCredential,
  type ShopifyTokenDb,
} from '../shopify-token';
import { encrypt, decrypt } from '@/lib/encryption';

/**
 * Tokens offline expirables (D29). Lo que tiene que quedar clavado:
 *   - un token legacy (custom app) pasa por todo el módulo SIN cambiar,
 *   - el refresh manda exactamente el body que documenta shopify.dev y el par
 *     nuevo queda persistido ANTES de devolverse (Shopify ya rotó),
 *   - el UPDATE es condicional al cifrado leído: nunca pisa lo que otro
 *     proceso (o un reinstall) escribió,
 *   - invalid_grant con la base sin cambios NO borra nada: error accionable + null,
 *   - invalid_grant por CARRERA con otro proceso (su UPDATE llega después del
 *     error) no pide reinstalar: espera, relee, y si el access viejo todavía
 *     vive lo usa,
 *   - el margen es del llamador: un job largo arranca con ~1 h entera,
 *   - ningún log de este módulo contiene un token.
 */

const NOW = 1_800_000_000_000;
const HORA = 3600 * 1000;
const TENANT = 'tenant-d29';
const SHOP = 'acme.myshopify.com';
const CLIENT = 'client-id-de-test';
const SECRET = 'secreto-de-test';

function envelope(over: Partial<ShopifyCredential> = {}): ShopifyCredential {
  return {
    access: 'shpat_viejo',
    exp: NOW + HORA,
    refresh: 'shprt_viejo',
    refreshExp: NOW + 90 * 24 * HORA,
    legacy: false,
    ...over,
  };
}

function tokenResponse(over: Record<string, unknown> = {}, status = 200): Response {
  return new Response(
    JSON.stringify({
      access_token: 'shpat_nuevo',
      expires_in: 3600,
      refresh_token: 'shprt_nuevo',
      refresh_token_expires_in: 7776000,
      scope: 'read_orders',
      ...over,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Tabla `Tenant` de una fila en memoria con la semántica del UPDATE optimista:
 * sólo cambia si el cifrado guardado es EXACTAMENTE el que el llamador leyó.
 */
function fakeDb(initialCipher: string | null) {
  const state = { cipher: initialCipher };
  const updateMany = vi.fn(async (args: { where: { id: string; shopifyToken: string }; data: { shopifyToken: string } }) => {
    if (args.where.id === TENANT && state.cipher === args.where.shopifyToken) {
      state.cipher = args.data.shopifyToken;
      return { count: 1 };
    }
    return { count: 0 };
  });
  const findUnique = vi.fn(async () => ({ shopifyToken: state.cipher }));
  const db: ShopifyTokenDb = { tenant: { updateMany, findUnique } };
  return { db, state, updateMany, findUnique };
}

/** Todo lo que el módulo escribió por console durante el test, serializado. */
const logs: string[] = [];
beforeEach(() => {
  __resetShopifyTokenState();
  logs.length = 0;
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});
afterEach(() => {
  // Ningún log de estas funciones lleva un token, ni completo ni truncado.
  for (const l of logs) {
    expect(l).not.toContain('shpat_');
    expect(l).not.toContain('shprt_');
  }
  vi.restoreAllMocks();
});

describe('parseShopifyCredential / serializeShopifyCredential', () => {
  it('legacy: un texto que no empieza con { es el token tal cual', () => {
    expect(parseShopifyCredential('shpat_custom_app')).toEqual({ access: 'shpat_custom_app', legacy: true });
    expect(serializeShopifyCredential({ access: 'shpat_custom_app', legacy: true })).toBe('shpat_custom_app');
  });

  it('v1: ida y vuelta con los cuatro campos', () => {
    const cred = envelope();
    const plain = serializeShopifyCredential(cred);
    expect(plain.startsWith('{')).toBe(true);
    expect(JSON.parse(plain)).toEqual({
      v: 1,
      access: 'shpat_viejo',
      exp: NOW + HORA,
      refresh: 'shprt_viejo',
      refreshExp: NOW + 90 * 24 * HORA,
    });
    expect(parseShopifyCredential(plain)).toEqual(cred);
  });

  it('v1 sin refresh: se parsea, sin campos inventados', () => {
    expect(parseShopifyCredential('{"v":1,"access":"shpat_x","exp":5}')).toEqual({ access: 'shpat_x', exp: 5, legacy: false });
  });

  it('plaintext corrupto → null (JSON roto, versión desconocida, sin access, vacío)', () => {
    expect(parseShopifyCredential('{no es json')).toBeNull();
    expect(parseShopifyCredential('{"v":2,"access":"shpat_x"}')).toBeNull();
    expect(parseShopifyCredential('{"v":1}')).toBeNull();
    expect(parseShopifyCredential('{"v":1,"access":""}')).toBeNull();
    expect(parseShopifyCredential('')).toBeNull();
    expect(parseShopifyCredential(null)).toBeNull();
    expect(parseShopifyCredential(undefined)).toBeNull();
  });

  it('credentialFromTokenResponse: con refresh_token arma el envelope; sin él es legacy', () => {
    expect(
      credentialFromTokenResponse(
        { access_token: 'shpat_a', expires_in: 3600, refresh_token: 'shprt_a', refresh_token_expires_in: 7776000 },
        NOW,
      ),
    ).toEqual({ access: 'shpat_a', exp: NOW + HORA, refresh: 'shprt_a', refreshExp: NOW + 7776000 * 1000, legacy: false });
    expect(credentialFromTokenResponse({ access_token: 'shpat_a', expires_in: 3600 }, NOW)).toEqual({
      access: 'shpat_a',
      legacy: true,
    });
  });
});

describe('isExpiringSoon', () => {
  it('con margen de 5 minutos por defecto', () => {
    expect(isExpiringSoon(envelope({ exp: NOW + 10 * 60 * 1000 }), NOW)).toBe(false);
    expect(isExpiringSoon(envelope({ exp: NOW + 5 * 60 * 1000 + 1 }), NOW)).toBe(false);
    expect(isExpiringSoon(envelope({ exp: NOW + 5 * 60 * 1000 }), NOW)).toBe(true);
    expect(isExpiringSoon(envelope({ exp: NOW + 4 * 60 * 1000 }), NOW)).toBe(true);
    expect(isExpiringSoon(envelope({ exp: NOW - 1 }), NOW)).toBe(true);
  });

  it('el skew es parámetro; legacy y sin exp nunca vencen', () => {
    expect(isExpiringSoon(envelope({ exp: NOW + 10 * 60 * 1000 }), NOW, 15 * 60 * 1000)).toBe(true);
    expect(isExpiringSoon({ access: 'shpat_x', legacy: true }, NOW)).toBe(false);
    expect(isExpiringSoon({ access: 'shpat_x', legacy: false }, NOW)).toBe(false);
  });
});

describe('refreshShopifyCredential', () => {
  it('manda el body exacto del protocolo y devuelve el par nuevo con vencimientos', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse());
    const cred = await refreshShopifyCredential({ shop: SHOP, refresh: 'shprt_viejo', clientId: CLIENT, secret: SECRET, fetchImpl, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      client_id: CLIENT,
      client_secret: SECRET,
      grant_type: 'refresh_token',
      refresh_token: 'shprt_viejo',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(cred).toEqual({
      access: 'shpat_nuevo',
      exp: NOW + HORA,
      refresh: 'shprt_nuevo',
      refreshExp: NOW + 7776000 * 1000,
      legacy: false,
    });
  });

  it('400 con invalid_grant → ShopifyRefreshInvalidGrant', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(
      refreshShopifyCredential({ shop: SHOP, refresh: 'shprt_viejo', clientId: CLIENT, secret: SECRET, fetchImpl }),
    ).rejects.toBeInstanceOf(ShopifyRefreshInvalidGrant);
  });

  it('401 con "invalid token" → ShopifyRefreshInvalidGrant', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"errors":"Invalid refresh token"}', { status: 401 }));
    await expect(
      refreshShopifyCredential({ shop: SHOP, refresh: 'shprt_viejo', clientId: CLIENT, secret: SECRET, fetchImpl }),
    ).rejects.toBeInstanceOf(ShopifyRefreshInvalidGrant);
  });

  it('400 con otro error NO es invalid_grant (es un ShopifyRefreshError genérico)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_request"}', { status: 400 }));
    const err = await refreshShopifyCredential({ shop: SHOP, refresh: 'shprt_viejo', clientId: CLIENT, secret: SECRET, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyRefreshError);
    expect(err).not.toBeInstanceOf(ShopifyRefreshInvalidGrant);
    expect(err).not.toBeInstanceOf(ShopifyRefreshTransient);
  });

  it('5xx, 429, red y timeout → ShopifyRefreshTransient', async () => {
    for (const status of [500, 502, 520, 429]) {
      const fetchImpl = vi.fn(async () => new Response('', { status }));
      await expect(
        refreshShopifyCredential({ shop: SHOP, refresh: 'shprt_viejo', clientId: CLIENT, secret: SECRET, fetchImpl }),
      ).rejects.toBeInstanceOf(ShopifyRefreshTransient);
    }
    const red = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(refreshShopifyCredential({ shop: SHOP, refresh: 'shprt_viejo', clientId: CLIENT, secret: SECRET, fetchImpl: red })).rejects.toBeInstanceOf(
      ShopifyRefreshTransient,
    );
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    const err = await refreshShopifyCredential({ shop: SHOP, refresh: 'shprt_viejo', clientId: CLIENT, secret: SECRET, fetchImpl: timeout }).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyRefreshTransient);
    expect(err.message).toBe('timeout');
  });
});

describe('getValidShopifyAccessToken', () => {
  /** Espera de la carrera sin dormir de verdad; registra cuánto se pidió esperar. */
  const esperas: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    esperas.push(ms);
  });
  beforeEach(() => {
    esperas.length = 0;
    sleep.mockClear();
  });
  const base = (db: ShopifyTokenDb, cipher: string | null, fetchImpl?: ReturnType<typeof vi.fn>, over: Record<string, unknown> = {}) => ({
    db,
    tenant: { id: TENANT, shopifyStoreUrl: SHOP, shopifyToken: cipher },
    clientId: CLIENT,
    secret: SECRET,
    now: NOW,
    fetchImpl: fetchImpl as unknown as (input: string, init?: RequestInit) => Promise<Response>,
    sleep,
    ...over,
  });

  it('legacy → exactamente el mismo string, sin tocar Shopify ni la base', async () => {
    const cipher = encrypt('shpat_custom_app');
    const { db, updateMany } = fakeDb(cipher);
    const fetchImpl = vi.fn();
    expect(await getValidShopifyAccessToken(base(db, cipher, fetchImpl))).toBe(decrypt(cipher));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('sin token → null; cifrado que no descifra → null', async () => {
    const { db } = fakeDb(null);
    expect(await getValidShopifyAccessToken(base(db, null))).toBeNull();
    expect(await getValidShopifyAccessToken(base(db, 'no:es:cifrado'))).toBeNull();
    expect(await getValidShopifyAccessToken(base(db, encrypt('{"v":1}')))).toBeNull();
  });

  it('envelope fresco → access sin llamar a Shopify', async () => {
    const cipher = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 30 * 60 * 1000 })));
    const { db, updateMany } = fakeDb(cipher);
    const fetchImpl = vi.fn();
    expect(await getValidShopifyAccessToken(base(db, cipher, fetchImpl))).toBe('shpat_viejo');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('expira pronto + secret → refresh, UPDATE optimista con el cifrado leído, persiste ANTES de devolver', async () => {
    const cipher = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 2 * 60 * 1000 })));
    const { db, state, updateMany } = fakeDb(cipher);
    const orden: string[] = [];
    const fetchImpl = vi.fn(async () => {
      orden.push('shopify');
      return tokenResponse();
    });
    updateMany.mockImplementationOnce(async (args) => {
      orden.push('update');
      state.cipher = args.data.shopifyToken;
      return { count: 1 };
    });

    const access = await getValidShopifyAccessToken(base(db, cipher, fetchImpl));
    orden.push('return');

    expect(access).toBe('shpat_nuevo');
    expect(orden).toEqual(['shopify', 'update', 'return']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const upd = updateMany.mock.calls[0][0];
    expect(upd.where).toEqual({ id: TENANT, shopifyToken: cipher });
    expect(upd.data.shopifyToken).not.toBe(cipher);
    expect(upd.data.shopifyToken).not.toContain('shpat_');
    expect(JSON.parse(decrypt(state.cipher as string))).toEqual({
      v: 1,
      access: 'shpat_nuevo',
      exp: NOW + HORA,
      refresh: 'shprt_nuevo',
      refreshExp: NOW + 7776000 * 1000,
    });
  });

  it('carrera en el mismo proceso: dos llamadas con el mismo envelope viejo → UN solo refresh, las dos reciben el nuevo', async () => {
    const cipher = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 60 * 1000 })));
    const { db, updateMany } = fakeDb(cipher);
    const fetchImpl = vi.fn(async () => tokenResponse());
    const [a, b] = await Promise.all([
      getValidShopifyAccessToken(base(db, cipher, fetchImpl)),
      getValidShopifyAccessToken(base(db, cipher, fetchImpl)),
    ]);
    expect(a).toBe('shpat_nuevo');
    expect(b).toBe('shpat_nuevo');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('carrera entre procesos: otro ya rotó (invalid_grant) → relee y usa el nuevo sin error', async () => {
    const viejo = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 60 * 1000 })));
    // La base ya tiene el par que rotó el otro proceso; este proceso leyó `viejo` antes.
    const rotadoPorOtro = encrypt(serializeShopifyCredential(envelope({ access: 'shpat_de_otro', refresh: 'shprt_de_otro', exp: NOW + HORA })));
    const { db, state, updateMany } = fakeDb(rotadoPorOtro);
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));

    expect(await getValidShopifyAccessToken(base(db, viejo, fetchImpl))).toBe('shpat_de_otro');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(updateMany).not.toHaveBeenCalled();
    expect(state.cipher).toBe(rotadoPorOtro);
    expect(logs.some((l) => l.includes('reinstalar'))).toBe(false);
  });

  it('refresh OK pero el UPDATE toca 0 filas (un reinstall escribió otro par) → relee y usa ese, sin pisarlo', async () => {
    const viejo = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 60 * 1000 })));
    const reinstalado = encrypt(serializeShopifyCredential(envelope({ access: 'shpat_reinstall', refresh: 'shprt_reinstall', exp: NOW + HORA })));
    const { db, state, updateMany } = fakeDb(reinstalado);
    const fetchImpl = vi.fn(async () => tokenResponse());

    expect(await getValidShopifyAccessToken(base(db, viejo, fetchImpl))).toBe('shpat_reinstall');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where.shopifyToken).toBe(viejo);
    expect(state.cipher).toBe(reinstalado);
  });

  it('sin secret → warn UNA vez por tenant y el access guardado; nunca llama a Shopify', async () => {
    const cipher = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 60 * 1000 })));
    const { db, updateMany } = fakeDb(cipher);
    const fetchImpl = vi.fn();
    const args = base(db, cipher, fetchImpl, { clientId: undefined, secret: undefined });
    expect(await getValidShopifyAccessToken(args)).toBe('shpat_viejo');
    expect(await getValidShopifyAccessToken(args)).toBe('shpat_viejo');
    expect(await getValidShopifyAccessToken({ ...args, tenant: { ...args.tenant, id: 'otro-tenant' } })).toBe('shpat_viejo');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    const avisos = logs.filter((l) => l.includes('SHOPIFY_API_KEY'));
    expect(avisos).toHaveLength(2); // uno por tenant, no por llamada
    expect(avisos[0]).toContain(TENANT);
  });

  it('invalid_grant con la base sin cambios y el access VENCIDO → null, error accionable, y el token NO se borra (dos relecturas con espera)', async () => {
    const cipher = encrypt(serializeShopifyCredential(envelope({ exp: NOW - 1000 })));
    const { db, state, updateMany, findUnique } = fakeDb(cipher);
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));

    const r = await resolveShopifyAccessToken(base(db, cipher, fetchImpl));
    expect(r.access).toBeNull();
    expect(r.reason).toBe('reinstall');
    expect(r.access === null && r.message).toBe(SHOPIFY_TOKEN_REINSTALL_MESSAGE);
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(esperas).toEqual([SHOPIFY_TOKEN_RACE_GRACE_MS]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(state.cipher).toBe(cipher);
    expect(logs.some((l) => l.includes('reinstalar la app') && l.includes(TENANT))).toBe(true);
  });

  it('carrera entre procesos: invalid_grant llega ANTES del UPDATE del otro; la segunda relectura (tras la espera) ya ve el par nuevo → se usa, sin pedir reinstalar', async () => {
    const viejo = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 60 * 1000 })));
    const rotadoPorOtro = encrypt(serializeShopifyCredential(envelope({ access: 'shpat_de_otro', refresh: 'shprt_de_otro', exp: NOW + HORA })));
    const { db, state, updateMany, findUnique } = fakeDb(viejo);
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    // El UPDATE del ganador aterriza durante la espera.
    sleep.mockImplementationOnce(async (ms: number) => {
      esperas.push(ms);
      state.cipher = rotadoPorOtro;
    });

    const r = await resolveShopifyAccessToken(base(db, viejo, fetchImpl));
    expect(r.access).toBe('shpat_de_otro');
    expect(r.reason).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(esperas).toEqual([SHOPIFY_TOKEN_RACE_GRACE_MS]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(state.cipher).toBe(rotadoPorOtro);
    expect(logs.some((l) => l.includes('reinstalar'))).toBe(false);
  });

  it('invalid_grant con la base estable pero el access todavía VIVO → devuelve ese access (reason null), avisa, y NO declara reinstall', async () => {
    const cipher = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 60 * 1000 })));
    const { db, state, updateMany, findUnique } = fakeDb(cipher);
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));

    const r = await resolveShopifyAccessToken(base(db, cipher, fetchImpl));
    expect(r.access).toBe('shpat_viejo');
    expect(r.reason).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(esperas).toEqual([SHOPIFY_TOKEN_RACE_GRACE_MS]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(state.cipher).toBe(cipher);
    expect(logs.some((l) => l.includes('invalid_grant') && l.includes('todavía no venció'))).toBe(true);
    expect(logs.some((l) => l.startsWith('[shopify/token] refresh rechazado (invalid_grant) y access vencido'))).toBe(false);
  });

  it('skewMs es del llamador: con 30 min de vida el default no renueva, SHOPIFY_TOKEN_JOB_SKEW_MS (55 min) sí, e Infinity fuerza la rotación de un par fresco', async () => {
    const treinta = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 30 * 60 * 1000 })));
    const { db: db1, updateMany: u1 } = fakeDb(treinta);
    const f1 = vi.fn(async () => tokenResponse());
    expect(await getValidShopifyAccessToken(base(db1, treinta, f1))).toBe('shpat_viejo');
    expect(f1).not.toHaveBeenCalled();
    expect(await getValidShopifyAccessToken(base(db1, treinta, f1, { skewMs: SHOPIFY_TOKEN_JOB_SKEW_MS }))).toBe('shpat_nuevo');
    expect(f1).toHaveBeenCalledTimes(1);
    expect(u1).toHaveBeenCalledTimes(1);

    const fresco = encrypt(serializeShopifyCredential(envelope({ exp: NOW + HORA })));
    const { db: db2 } = fakeDb(fresco);
    const f2 = vi.fn(async () => tokenResponse());
    expect(await getValidShopifyAccessToken(base(db2, fresco, f2, { skewMs: Number.POSITIVE_INFINITY }))).toBe('shpat_nuevo');
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('sin secret y margen de job: con 30 min de vida devuelve el access SIN avisar (no hay riesgo real); con 2 min avisa una vez', async () => {
    const treinta = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 30 * 60 * 1000 })));
    const { db: db1 } = fakeDb(treinta);
    const fetchImpl = vi.fn();
    const sinSecret = { clientId: undefined, secret: undefined, skewMs: SHOPIFY_TOKEN_JOB_SKEW_MS };
    expect(await getValidShopifyAccessToken(base(db1, treinta, fetchImpl, sinSecret))).toBe('shpat_viejo');
    expect(logs.filter((l) => l.includes('SHOPIFY_API_KEY'))).toHaveLength(0);

    const dos = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 2 * 60 * 1000 })));
    const { db: db2 } = fakeDb(dos);
    expect(await getValidShopifyAccessToken(base(db2, dos, fetchImpl, sinSecret))).toBe('shpat_viejo');
    expect(await getValidShopifyAccessToken(base(db2, dos, fetchImpl, sinSecret))).toBe('shpat_viejo');
    expect(logs.filter((l) => l.includes('SHOPIFY_API_KEY'))).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('la resolución dice si el token es legacy (string fijo) o expirable (hay que re-resolver)', async () => {
    const legacy = encrypt('shpat_custom_app');
    const { db: db1 } = fakeDb(legacy);
    const r1 = await resolveShopifyAccessToken(base(db1, legacy));
    expect(r1.reason === null && r1.legacy).toBe(true);

    const env = encrypt(serializeShopifyCredential(envelope({ exp: NOW + HORA })));
    const { db: db2 } = fakeDb(env);
    const r2 = await resolveShopifyAccessToken(base(db2, env));
    expect(r2.reason === null && r2.legacy).toBe(false);
  });

  it('fallo transitorio: si el access todavía sirve se devuelve; si ya venció, null con motivo reintentable', async () => {
    const vivo = encrypt(serializeShopifyCredential(envelope({ exp: NOW + 2 * 60 * 1000 })));
    const { db: db1 } = fakeDb(vivo);
    const caido = vi.fn(async () => new Response('', { status: 520 }));
    expect(await getValidShopifyAccessToken(base(db1, vivo, caido))).toBe('shpat_viejo');

    const vencido = encrypt(serializeShopifyCredential(envelope({ exp: NOW - 1000 })));
    const { db: db2, state } = fakeDb(vencido);
    const r = await resolveShopifyAccessToken(base(db2, vencido, caido));
    expect(r.access).toBeNull();
    expect(r.reason).toBe('refresh-failed');
    expect(state.cipher).toBe(vencido);
  });

  it('envelope sin refresh y access vencido → reinstall (no hay con qué renovar)', async () => {
    const cipher = encrypt(serializeShopifyCredential(envelope({ exp: NOW - 1000, refresh: undefined, refreshExp: undefined })));
    const { db } = fakeDb(cipher);
    const fetchImpl = vi.fn();
    const r = await resolveShopifyAccessToken(base(db, cipher, fetchImpl));
    expect(r.access).toBeNull();
    expect(r.reason).toBe('reinstall');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
