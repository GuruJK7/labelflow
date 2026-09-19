import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `GET /api/credit-packs/shopify-checkout` — el arranque del cobro por la
 * Billing API.
 *
 * Lo que se prueba es lo que puede costar plata o una revisión rechazada:
 *   - El monto NO viene del cliente: sale del catálogo. Un `?pack=` inventado
 *     se rechaza; no hay forma de pedir "250 envíos por USD 1".
 *   - La tienda sin Shopify no puede usar este riel (409), así no se le crea
 *     una compra fantasma.
 *   - Si Shopify falla, la compra queda FAILED y nunca PENDING colgada.
 *   - En tienda de desarrollo el cargo va como `test`, que es como el revisor
 *     de Shopify puede aprobarlo sin que le cobren.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindUnique: vi.fn(),
  purchaseCreate: vi.fn(),
  purchaseUpdate: vi.fn(),
  shopifyAccessForTenant: vi.fn(),
  createOneTimeCharge: vi.fn(),
  isDevelopmentStore: vi.fn(),
  registerShopifyWebhooks: vi.fn(),
}));

vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: { findUnique: mocks.tenantFindUnique },
    creditPurchase: { create: mocks.purchaseCreate, update: mocks.purchaseUpdate },
  },
}));
vi.mock('@/lib/shopify-access', () => ({ shopifyAccessForTenant: mocks.shopifyAccessForTenant }));
vi.mock('@/lib/shopify-register-webhooks', () => ({
  registerShopifyWebhooks: mocks.registerShopifyWebhooks,
}));
vi.mock('@/lib/shopify-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shopify-billing')>()),
  createOneTimeCharge: mocks.createOneTimeCharge,
  isDevelopmentStore: mocks.isDevelopmentStore,
}));

import { GET } from '@/app/api/credit-packs/shopify-checkout/route';
import { NextRequest } from 'next/server';

const TIENDA_SHOPIFY = {
  id: 't1',
  shopifyStoreUrl: 'kaia-store.myshopify.com',
  shopifyToken: 'enc:token',
};

/** El motivo con el que el checkout devuelve al panel (`/settings/billing?error=…`). */
function motivoDe(res: Response): string | null {
  const loc = res.headers.get('location');
  if (!loc) return null;
  const u = new URL(loc);
  if (u.pathname !== '/settings/billing') return `fuera:${u.pathname}`;
  return u.searchParams.get('error');
}

function pedir(pack: string | null) {
  const url = pack
    ? `https://autoenvia.com/api/credit-packs/shopify-checkout?pack=${pack}`
    : 'https://autoenvia.com/api/credit-packs/shopify-checkout';
  return GET(new NextRequest(url));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';
  mocks.getAuthenticatedTenant.mockResolvedValue({ tenantId: 't1' });
  mocks.tenantFindUnique.mockResolvedValue(TIENDA_SHOPIFY);
  mocks.shopifyAccessForTenant.mockResolvedValue('shpat_token');
  mocks.purchaseCreate.mockResolvedValue({ id: 'cp_1' });
  mocks.purchaseUpdate.mockResolvedValue({});
  mocks.isDevelopmentStore.mockResolvedValue(false);
  mocks.registerShopifyWebhooks.mockResolvedValue({ registered: [], alreadyPresent: [], failed: [] });
  mocks.createOneTimeCharge.mockResolvedValue({
    chargeId: 'gid://shopify/AppPurchaseOneTime/1',
    confirmationUrl: 'https://kaia-store.myshopify.com/admin/charges/1/confirm',
    status: 'PENDING',
  });
});

describe('el monto sale del catálogo, no del cliente', () => {
  it('cobra el total del pack de 250: USD 75,00', async () => {
    const res = await pedir('pack_250');
    expect(res.status).toBe(307);
    expect(mocks.createOneTimeCharge).toHaveBeenCalledWith(
      expect.objectContaining({ totalUsdMilli: 75_000, name: 'AutoEnvía · 250 envíos' }),
    );
  });

  it('un pack inventado se rechaza antes de crear nada, y vuelve al panel con el motivo', async () => {
    const res = await pedir('pack_1');
    expect(res.status).toBe(307);
    expect(motivoDe(res)).toBe('pack');
    expect(mocks.purchaseCreate).not.toHaveBeenCalled();
    expect(mocks.createOneTimeCharge).not.toHaveBeenCalled();
  });

  it('sin parámetro pack, vuelve al panel con error=pack', async () => {
    expect(motivoDe(await pedir(null))).toBe('pack');
    expect(mocks.createOneTimeCharge).not.toHaveBeenCalled();
  });

  it('sin sesión: al login, sin mirar el pack', async () => {
    mocks.getAuthenticatedTenant.mockResolvedValue(null);
    const res = await pedir('pack_250');
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(mocks.purchaseCreate).not.toHaveBeenCalled();
  });
});

describe('sólo tiendas conectadas por Shopify', () => {
  it('una tienda sin Shopify vuelve al panel con error=tienda y no se le crea compra', async () => {
    mocks.tenantFindUnique.mockResolvedValue({ ...TIENDA_SHOPIFY, shopifyStoreUrl: null });
    const res = await pedir('pack_250');
    expect(motivoDe(res)).toBe('tienda');
    expect(mocks.purchaseCreate).not.toHaveBeenCalled();
  });

  it('un token que no se puede resolver también corta antes de crear: error=token', async () => {
    mocks.shopifyAccessForTenant.mockResolvedValue(null);
    const res = await pedir('pack_250');
    expect(motivoDe(res)).toBe('token');
    expect(mocks.purchaseCreate).not.toHaveBeenCalled();
  });
});

describe('tienda de desarrollo', () => {
  it('el cargo va como test: el revisor de Shopify lo aprueba sin que le cobren', async () => {
    mocks.isDevelopmentStore.mockResolvedValue(true);
    await pedir('pack_250');
    expect(mocks.createOneTimeCharge).toHaveBeenCalledWith(expect.objectContaining({ test: true }));
  });

  it('en una tienda real el cargo NO es de prueba', async () => {
    await pedir('pack_250');
    expect(mocks.createOneTimeCharge).toHaveBeenCalledWith(expect.objectContaining({ test: false }));
  });
});

describe('cuando Shopify falla', () => {
  it('🔴 si no se pudo saber si es tienda de desarrollo, NO se crea cargo y el panel dice que reintente', async () => {
    // Antes un "no sé" se convertía en `test:false`: en una dev store Shopify
    // rechaza el cargo real y el revisor comía un 502 sin explicación. Y el
    // 502 era JSON crudo en la pestaña: ahora es un redirect con motivo.
    const { ShopifyPlanUnresolvedError } = await import('@/lib/shopify-billing');
    mocks.isDevelopmentStore.mockRejectedValue(new ShopifyPlanUnresolvedError('status=429'));
    const res = await pedir('pack_250');
    expect(res.status).toBe(307);
    expect(motivoDe(res)).toBe('verificacion_tienda');
    expect(mocks.createOneTimeCharge).not.toHaveBeenCalled();
    // Y la compra no queda PENDING colgada.
    expect(mocks.purchaseUpdate).toHaveBeenCalledWith({ where: { id: 'cp_1' }, data: { status: 'FAILED' } });
  });

  it('la compra queda FAILED, no PENDING colgada, y el panel muestra el error (no JSON crudo)', async () => {
    mocks.createOneTimeCharge.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await pedir('pack_250');
    expect(res.status).toBe(307);
    expect(motivoDe(res)).toBe('cobro_shopify');
    expect(mocks.purchaseUpdate).toHaveBeenCalledWith({
      where: { id: 'cp_1' },
      data: { status: 'FAILED' },
    });
    spy.mockRestore();
  });
});

describe('la vuelta del comerciante', () => {
  it('el returnUrl lleva el id de la compra, que es como se resuelve al volver', async () => {
    await pedir('pack_250');
    expect(mocks.createOneTimeCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: 'https://autoenvia.com/api/credit-packs/shopify-return?purchase=cp_1',
      }),
    );
  });

  it('el GID del cargo se guarda: es la única forma de que el webhook lo encuentre', async () => {
    await pedir('pack_250');
    expect(mocks.purchaseUpdate).toHaveBeenCalledWith({
      where: { id: 'cp_1' },
      data: { mpPreferenceId: 'gid://shopify/AppPurchaseOneTime/1', mpExternalRef: 'shopify|cp_1' },
    });
  });
});


describe('el webhook de cobro se asegura antes de cobrar', () => {
  it('se registra el topic de cobro, y sólo ese', async () => {
    // Los webhooks son por tienda y se registran al instalar: una tienda
    // conectada antes de que existiera este riel no lo tiene, y el modo de
    // fallo es el peor — paga y no se le acredita.
    await pedir('pack_250');
    expect(mocks.registerShopifyWebhooks).toHaveBeenCalledWith(
      'kaia-store.myshopify.com',
      'shpat_token',
      'https://autoenvia.com',
      ['app_purchases_one_time/update'],
    );
  });

  it('si el registro falla, la compra sigue: el retorno acredita igual', async () => {
    mocks.registerShopifyWebhooks.mockRejectedValue(new Error('shopify caído'));
    const res = await pedir('pack_250');
    expect(res.status).toBe(307);
    expect(mocks.createOneTimeCharge).toHaveBeenCalledTimes(1);
  });

  it('un userError en el registro tampoco frena el cobro', async () => {
    mocks.registerShopifyWebhooks.mockResolvedValue({
      registered: [],
      alreadyPresent: [],
      failed: [{ topic: 'app_purchases_one_time/update', status: 200, body: 'ACCESS_DENIED' }],
    });
    expect((await pedir('pack_250')).status).toBe(307);
    expect(mocks.createOneTimeCharge).toHaveBeenCalledTimes(1);
  });
});
