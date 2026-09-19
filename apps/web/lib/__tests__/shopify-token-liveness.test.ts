/**
 * 🔴 POR QUÉ ESTE TEST. `/api/shopify/entry` daba por "conectada" a toda tienda
 * con `shopifyToken != null`. Lo único que pone ese token en null es el webhook
 * `app/uninstalled`, que es best-effort: si no llegaba, reinstalar no volvía a
 * pedir OAuth nunca más. El revisor del App Store desinstala y reinstala.
 *
 * Acá se fija la tabla de decisión entera. Las dos reglas que la ordenan:
 *   1. El token sólo se da por MUERTO con evidencia de Shopify (401/403 al
 *      ping, o refresh terminal). Un fallo nuestro es `indeterminada`.
 *   2. Si el refresh falló sin ser terminal, se pinguea igual con el access
 *      GUARDADO, vencido o no: así la decisión no depende de clasificar bien
 *      el cuerpo de error del refresh — que fue lo que falló la primera vez
 *      (Shopify devuelve `401 invalid_request` para la app desinstalada, y el
 *      patrón de `invalid_grant` no lo reconocía).
 *
 * Sin red: el resolvedor y el cliente GraphQL van mockeados; el descifrado es
 * identidad para poder pasar el token guardado en texto plano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), graphql: vi.fn() }));
vi.mock('@/lib/shopify-access', () => ({ resolveShopifyAccessForTenant: mocks.resolve }));
vi.mock('@/lib/shopify-graphql', () => ({ shopifyGraphql: mocks.graphql }));
vi.mock('@/lib/encryption', () => ({ decryptIfPresent: (v: string | null) => v ?? null }));

import { vitalidadSegunPing, vitalidadDelToken, SHOP_PING_QUERY, PING_TIMEOUT_MS } from '../shopify-token-liveness';

const SHOP = 'acme.myshopify.com';
/** El token guardado, en texto plano (legacy): `parseShopifyCredential` lo lee tal cual. */
const TENANT = { id: 't1', shopifyStoreUrl: SHOP, shopifyToken: 'shpat_guardado' };

const r200 = { status: 200, data: { shop: { id: 'gid://shopify/Shop/1' } }, errors: [], bodyText: '' };
const r401 = { status: 401, data: null, errors: [], bodyText: '' };
const r500 = { status: 500, data: null, errors: [], bodyText: '' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ access: 'shpat_resuelto', reason: null, legacy: false });
});

describe('vitalidadSegunPing (la tabla de decisión)', () => {
  it('200 con shop → viva', () => {
    expect(vitalidadSegunPing(200, true)).toBe('viva');
  });

  it('🔴 401 → muerta: el token fue revocado (la app se desinstaló) o venció', () => {
    expect(vitalidadSegunPing(401, false)).toBe('muerta');
  });

  it('403 → muerta: la app no está autorizada en esa tienda', () => {
    expect(vitalidadSegunPing(403, false)).toBe('muerta');
  });

  it('5xx, 429, 0 → indeterminada: no se sabe, y no se adivina', () => {
    expect(vitalidadSegunPing(500, false)).toBe('indeterminada');
    expect(vitalidadSegunPing(502, false)).toBe('indeterminada');
    expect(vitalidadSegunPing(429, false)).toBe('indeterminada');
    expect(vitalidadSegunPing(0, false)).toBe('indeterminada');
  });

  it('200 sin shop en el cuerpo tampoco es viva', () => {
    expect(vitalidadSegunPing(200, false)).toBe('indeterminada');
  });
});

describe('vitalidadDelToken con el token resuelto', () => {
  it('resuelve el token y hace el ping mínimo con timeout corto', async () => {
    mocks.graphql.mockResolvedValue(r200);
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('viva');
    expect(mocks.resolve).toHaveBeenCalledWith(TENANT);
    const [shop, token, query, , opts] = mocks.graphql.mock.calls[0];
    expect(shop).toBe(SHOP);
    expect(token).toBe('shpat_resuelto');
    expect(query).toBe(SHOP_PING_QUERY);
    expect(opts).toEqual({ timeoutMs: PING_TIMEOUT_MS });
  });

  it('🔴 Shopify contesta 401 → muerta (reinstalación dentro de la hora, sin webhook)', async () => {
    mocks.graphql.mockResolvedValue(r401);
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('muerta');
  });

  it('el ping tira (timeout, red) → indeterminada, nunca una excepción hacia /entry', async () => {
    mocks.graphql.mockRejectedValue(new Error('timeout'));
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('indeterminada');
  });

  it('un token legacy (shpat_ pegado a mano) también se pinguea: si vive, viva', async () => {
    mocks.resolve.mockResolvedValue({ access: 'shpat_legacy', reason: null, legacy: true });
    mocks.graphql.mockResolvedValue(r200);
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('viva');
    expect(mocks.graphql.mock.calls[0][1]).toBe('shpat_legacy');
  });
});

describe('vitalidadDelToken cuando el resolvedor NO dio access', () => {
  it("refresh terminal ('reinstall') → muerta sin pinguear: Shopify ya dijo que el par no sirve", async () => {
    mocks.resolve.mockResolvedValue({ access: null, reason: 'reinstall', message: '…' });
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('muerta');
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it("🔴 'refresh-failed' → se pinguea con el access GUARDADO: 401 → muerta (reinstalar al día siguiente)", async () => {
    // Éste es el caso que el primer arreglo NO cubría: el access venció, el
    // refresh falla con un cuerpo que no clasificamos como terminal, y antes
    // eso era 'indeterminada' → login → el bug original.
    mocks.resolve.mockResolvedValue({ access: null, reason: 'refresh-failed', message: '…' });
    mocks.graphql.mockResolvedValue(r401);
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('muerta');
    expect(mocks.graphql).toHaveBeenCalledTimes(1);
    expect(mocks.graphql.mock.calls[0][1]).toBe('shpat_guardado');
  });

  it("'refresh-failed' pero el access guardado todavía anda (200) → viva", async () => {
    mocks.resolve.mockResolvedValue({ access: null, reason: 'refresh-failed', message: '…' });
    mocks.graphql.mockResolvedValue(r200);
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('viva');
  });

  it("'refresh-failed' y Shopify caído (5xx) → indeterminada", async () => {
    mocks.resolve.mockResolvedValue({ access: null, reason: 'refresh-failed', message: '…' });
    mocks.graphql.mockResolvedValue(r500);
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('indeterminada');
  });

  it('el resolvedor TIRA (base, cifrado) → se pinguea con lo guardado; 401 → muerta', async () => {
    mocks.resolve.mockRejectedValue(new Error('db caída'));
    mocks.graphql.mockResolvedValue(r401);
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('muerta');
  });

  it("🔴 'unreadable' (no descifra) → indeterminada y SIN ping: evidencia local nunca mata un token", async () => {
    // Una ENCRYPTION_KEY mal puesta en un deploy no puede destruir tokens
    // recuperables — sobre todo los legacy pegados a mano. Invariante de
    // shopify-token.ts: «NO se borra el token».
    mocks.resolve.mockResolvedValue({ access: null, reason: 'unreadable', message: '…' });
    expect(await vitalidadDelToken(TENANT, SHOP)).toBe('indeterminada');
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it("'no-token' → indeterminada: no hay nada que pinguear ni que borrar", async () => {
    mocks.resolve.mockResolvedValue({ access: null, reason: 'no-token', message: '…' });
    expect(await vitalidadDelToken({ ...TENANT, shopifyToken: null }, SHOP)).toBe('indeterminada');
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it("'refresh-failed' con un token guardado ilegible → indeterminada", async () => {
    mocks.resolve.mockResolvedValue({ access: null, reason: 'refresh-failed', message: '…' });
    // Un envelope corrupto: empieza con { pero no es el JSON v1.
    expect(await vitalidadDelToken({ ...TENANT, shopifyToken: '{"basura":1}' }, SHOP)).toBe('indeterminada');
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
});
