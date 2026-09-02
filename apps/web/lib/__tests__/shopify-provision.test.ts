import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.ENCRYPTION_KEY = '11'.repeat(32);

const { tx, db } = vi.hoisted(() => {
  const tx = {
    user: { findUnique: vi.fn(), create: vi.fn() },
    tenant: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  };
  const db = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    tenant: tx.tenant,
    user: tx.user,
  };
  return { tx, db };
});
vi.mock('@/lib/db', () => ({ db }));

import { tenantSlugForShop, provisionFromShopify } from '../shopify-provision';
import { decrypt } from '../encryption';
import { fakeTenantFindFirst } from './_shopify-route-utils';

/**
 * El slug es la clave de idempotencia del alta desde el App Store: reinstalar
 * tiene que reusar la misma tienda, no crear una nueva. Si esta función deja de
 * ser estable, cada reinstalación duplica el tenant del comerciante.
 */
describe('tenantSlugForShop', () => {
  it('es estable: el mismo dominio da siempre el mismo slug', () => {
    expect(tenantSlugForShop('mi-tienda.myshopify.com')).toBe('shop-mi-tienda');
    expect(tenantSlugForShop('mi-tienda.myshopify.com')).toBe('shop-mi-tienda');
  });

  it('dos tiendas distintas nunca colisionan', () => {
    const a = tenantSlugForShop('aura.myshopify.com');
    const b = tenantSlugForShop('kinevia.myshopify.com');
    expect(a).not.toBe(b);
  });

  it('sale del handle, no del dominio completo', () => {
    expect(tenantSlugForShop('cfzf6b-dk.myshopify.com')).toBe('shop-cfzf6b-dk');
  });

  it('descarta cualquier carácter que no sea seguro en un slug', () => {
    expect(tenantSlugForShop('Tienda_Rara!.myshopify.com')).toMatch(/^shop-[a-z0-9-]*$/);
  });

  it('un handle de exactamente 40 chars se usa tal cual', () => {
    const h = 'a'.repeat(40);
    expect(tenantSlugForShop(`${h}.myshopify.com`)).toBe(`shop-${h}`);
  });

  it('acota el largo a 45 y sigue siendo determinista', () => {
    const shop = 'a'.repeat(120) + '.myshopify.com';
    const s = tenantSlugForShop(shop);
    expect(s.length).toBeLessThanOrEqual(45);
    expect(s.startsWith('shop-')).toBe(true);
    expect(s).toMatch(/^shop-[a-z0-9-]{31}-[0-9a-f]{8}$/);
    expect(tenantSlugForShop(shop)).toBe(s);
  });

  it('dos handles largos con el mismo prefijo NO colisionan (antes sí)', () => {
    const prefijo = 'tienda-con-un-nombre-realmente-largo-';
    const a = tenantSlugForShop(`${prefijo}sucursal-uno.myshopify.com`);
    const b = tenantSlugForShop(`${prefijo}sucursal-dos.myshopify.com`);
    expect(a.slice(0, 36)).toBe(b.slice(0, 36)); // mismo prefijo visible
    expect(a).not.toBe(b);
  });
});

/**
 * provisionFromShopify decide QUIÉN es el dueño de la tienda. El email de la
 * tienda NO es identidad verificada (D11): nunca se cuelga una tienda nueva a
 * una cuenta que ya existe.
 */
describe('provisionFromShopify', () => {
  const info = { email: 'dueno@tienda.com', name: 'Mi Tienda', domain: 'mi-tienda.myshopify.com' };

  beforeEach(() => {
    vi.clearAllMocks();
    tx.tenant.findUnique.mockResolvedValue(null); // referralCode libre
  });

  it("tienda nueva + email sin cuenta → 'created' con apiKey aleatoria y referralCode", async () => {
    tx.user.findUnique.mockResolvedValue(null);
    tx.tenant.findFirst.mockResolvedValue(null);
    tx.user.create.mockResolvedValue({ id: 'u1', tenants: [{ id: 't1' }] });

    const out = await provisionFromShopify(info, 'shpat_token');
    expect(out).toEqual({ kind: 'created', userId: 'u1', tenantId: 't1', email: info.email });

    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.email).toBe(info.email);
    const tenant = data.tenants.create[0];
    expect(tenant.slug).toBe('shop-mi-tienda');
    expect(tenant.apiKey).toMatch(/^[0-9a-f]{64}$/); // randomBytes(32), no cuid
    expect(tenant.referralCode).toMatch(/^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/);
    expect(tenant.tosAcceptedAt).toBeUndefined(); // no aceptó nuestros términos
    expect(decrypt(tenant.shopifyToken)).toBe('shpat_token');
    expect(tenant.shopifyStoreUrl).toBe(info.domain);
    // D31: cuenta nueva → 5 envíos explícitos, no el default del schema (10).
    expect(tenant.shipmentCredits).toBe(5);
  });

  it("tienda nueva + email CON cuenta → 'claim' y NO escribe nada", async () => {
    tx.user.findUnique.mockResolvedValue({ id: 'u-existente' });
    tx.tenant.findFirst.mockResolvedValue(null);

    const out = await provisionFromShopify(info, 'shpat_token');
    expect(out).toEqual({ kind: 'claim', email: info.email });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.tenant.create).not.toHaveBeenCalled();
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });

  it("tienda ya vinculada al User de ese email → 'existing', refresca sólo el token", async () => {
    tx.user.findUnique.mockResolvedValue({ id: 'u1' });
    tx.tenant.findFirst.mockResolvedValue({ id: 't1', userId: 'u1' });

    const out = await provisionFromShopify(info, 'shpat_nuevo');
    expect(out).toEqual({ kind: 'existing', userId: 'u1', tenantId: 't1', email: info.email });
    const upd = tx.tenant.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 't1' });
    expect(Object.keys(upd.data)).toEqual(['shopifyToken']);
    expect(decrypt(upd.data.shopifyToken)).toBe('shpat_nuevo');
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it("la fila guardada como 'Mi-Tienda.myshopify.com' (token manual) se encuentra con el dominio en minúsculas → 'existing' (D18)", async () => {
    tx.user.findUnique.mockResolvedValue({ id: 'u1' });
    tx.tenant.findFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 't1', shopifyStoreUrl: 'Mi-Tienda.myshopify.com', userId: 'u1' }]),
    );

    const out = await provisionFromShopify(info, 'shpat_nuevo');
    // Sin la búsqueda insensible esto daba 'claim' (o 'created' si el email
    // no tenía cuenta): un segundo tenant para la misma tienda.
    expect(out).toEqual({ kind: 'existing', userId: 'u1', tenantId: 't1', email: info.email });
    expect(tx.tenant.findFirst.mock.calls[0][0].where).toEqual({
      shopifyStoreUrl: { equals: 'mi-tienda.myshopify.com', mode: 'insensitive' },
    });
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it("tienda vinculada a OTRO user → 'conflict', no se mueve", async () => {
    tx.user.findUnique.mockResolvedValue({ id: 'u-atacante' });
    tx.tenant.findFirst.mockResolvedValue({ id: 't1', userId: 'u-victima' });

    const out = await provisionFromShopify(info, 'shpat_token');
    expect(out).toEqual({ kind: 'conflict', reason: 'shop_taken' });
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.tenant.create).not.toHaveBeenCalled();
  });

  it("dominio ya vinculado escrito con MAYÚSCULAS y otro user → 'conflict', nunca acredita (D31)", async () => {
    tx.user.findUnique.mockResolvedValue({ id: 'u-nuevo' });
    tx.tenant.findFirst.mockImplementation(
      fakeTenantFindFirst([{ id: 't1', shopifyStoreUrl: 'MI-TIENDA.MYSHOPIFY.COM', userId: 'u-dueno' }]),
    );

    const out = await provisionFromShopify(info, 'shpat_token');
    expect(out).toEqual({ kind: 'conflict', reason: 'shop_taken' });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.tenant.create).not.toHaveBeenCalled();
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });

  it("tienda vinculada y el email de la tienda no tiene cuenta → 'conflict'", async () => {
    tx.user.findUnique.mockResolvedValue(null);
    tx.tenant.findFirst.mockResolvedValue({ id: 't1', userId: 'u-otro' });

    const out = await provisionFromShopify(info, 'shpat_token');
    expect(out).toEqual({ kind: 'conflict', reason: 'shop_taken' });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.tenant.create).not.toHaveBeenCalled();
  });

  it('el chequeo de tienda tomada corre ADENTRO de la transacción', async () => {
    tx.user.findUnique.mockResolvedValue(null);
    tx.tenant.findFirst.mockResolvedValue(null);
    tx.user.create.mockResolvedValue({ id: 'u1', tenants: [{ id: 't1' }] });
    await provisionFromShopify(info, 'x');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // findFirst se llamó sobre el cliente de la transacción, no antes.
    expect(tx.tenant.findFirst).toHaveBeenCalledTimes(1);
  });

  it("carrera perdida (P2002 en el insert) → 'conflict', no 500", async () => {
    tx.user.findUnique.mockResolvedValue(null);
    tx.tenant.findFirst.mockResolvedValue(null);
    tx.user.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const out = await provisionFromShopify(info, 'x');
    expect(out).toEqual({ kind: 'conflict', reason: 'shop_taken' });
  });

  it('otros errores de base se propagan', async () => {
    tx.user.findUnique.mockRejectedValue(new Error('conexión caída'));
    await expect(provisionFromShopify(info, 'x')).rejects.toThrow('conexión caída');
  });
});
