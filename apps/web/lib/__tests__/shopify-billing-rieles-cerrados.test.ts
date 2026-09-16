import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 🔴 REQUISITO 1.2.1 DEL APP STORE, DEL LADO DEL SERVER.
 *
 * «Apps that use off-platform billing cannot be distributed through the
 * Shopify App Store.» Hasta ahora el corte era SÓLO DE UI: el test hermano
 * (`shopify-billing-ui.test.ts`) prueba que la pantalla de compra esconde los
 * botones de MercadoPago y Whop cuando la tienda entró por Shopify, pero una
 * pantalla que esconde un botón no cierra un endpoint. Los tres GET seguían
 * abiertos: con la URL a mano —un bookmark viejo, el historial del navegador,
 * un revisor tecleando— creaban igual la preferencia de MercadoPago, la
 * suscripción PreApproval o el redirect a Whop. Eso ES cobro fuera de la
 * plataforma, y en el caso de la PreApproval es un cobro RECURRENTE.
 *
 * EL CUARTO RIEL (`/api/recover/subscribe`) se sumó después: es el más caro de
 * todos y el único que nunca tuvo botón que esconder. Crea una PreApproval de
 * $490 UYU/MES para el módulo Recover con sólo pegar la URL estando logueado.
 * Un cobro recurrente que nadie ve en pantalla es peor que uno que se ofrece:
 * sigue corriendo todos los meses hasta que alguien lo cancele a mano.
 *
 * Este archivo prueba los CUATRO rieles y las dos mitades del contrato:
 *
 *   1. Tenant de Shopify → 409 en los cuatro, sin crear compra ni tocar MP/Whop.
 *   2. Tenant que NO es de Shopify (carga propia, DEPO) → sigue cobrando por
 *      donde siempre. Romper eso sería peor que el problema que arregla.
 *   3. PARIDAD con `/api/credit-packs/me`: para las cuatro combinaciones de
 *      `shopifyStoreUrl`/`shopifyToken`, el 409 del server y la bandera
 *      `shopifyBilling` de la pantalla tienen que decir exactamente lo mismo.
 *      Si divergen, la UI ofrece un botón que el server rechaza (o peor: el
 *      server acepta lo que la UI escondió) y volvemos al bug original.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedTenant: vi.fn(),
  tenantFindUnique: vi.fn(),
  tenantFindFirst: vi.fn(),
  tenantFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  purchaseCreate: vi.fn(),
  purchaseUpdate: vi.fn(),
  purchaseFindFirst: vi.fn(),
  purchaseFindMany: vi.fn(),
  preferenceCreate: vi.fn(),
  preApprovalCreate: vi.fn(),
}));

vi.mock('@/lib/api-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-utils')>()),
  getAuthenticatedTenant: mocks.getAuthenticatedTenant,
}));
vi.mock('@/lib/db', () => ({
  db: {
    tenant: {
      findUnique: mocks.tenantFindUnique,
      findFirst: mocks.tenantFindFirst,
      findMany: mocks.tenantFindMany,
    },
    user: { findUnique: mocks.userFindUnique },
    creditPurchase: {
      create: mocks.purchaseCreate,
      update: mocks.purchaseUpdate,
      findFirst: mocks.purchaseFindFirst,
      findMany: mocks.purchaseFindMany,
    },
  },
}));
// PLANS y el resto quedan REALES: lo único que se intercepta es el cliente que
// habla con MercadoPago, para poder afirmar que no se lo llamó.
vi.mock('@/lib/mercadopago', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mercadopago')>()),
  getPreferenceClient: () => ({ create: mocks.preferenceCreate }),
  getPreApprovalClient: () => ({ create: mocks.preApprovalCreate }),
}));

import { NextRequest } from 'next/server';
import { GET as packMercadoPago } from '@/app/api/credit-packs/checkout/route';
import { GET as packWhop } from '@/app/api/credit-packs/whop-checkout/route';
import { GET as suscripcionMercadoPago } from '@/app/api/mercadopago/checkout/route';
import { GET as suscripcionRecover } from '@/app/api/recover/subscribe/route';
import { GET as creditPacksMe } from '@/app/api/credit-packs/me/route';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VolumeSelector } from '@/app/(dashboard)/settings/billing/_components/VolumeSelector';

const PACK = 'pack_100';
const WHOP_URL = 'https://whop.com/checkout/plan_abc';

/** Los cuatro estados posibles del par de columnas que decide el riel. */
const TIENDA_SHOPIFY = { shopifyStoreUrl: 'kaia-store.myshopify.com', shopifyToken: 'enc:token' };
const TIENDA_PROPIA = { shopifyStoreUrl: null, shopifyToken: null };
const SOLO_URL = { shopifyStoreUrl: 'kaia-store.myshopify.com', shopifyToken: null };
const SOLO_TOKEN = { shopifyStoreUrl: null, shopifyToken: 'enc:token' };

type Tienda = { shopifyStoreUrl: string | null; shopifyToken: string | null };

/** Qué tenant devuelve la base en este test. */
let tiendaActual: Tienda = TIENDA_PROPIA;

const WALLET = {
  shipmentCredits: 12,
  creditsPurchased: 100,
  creditsConsumed: 88,
  referralCreditsEarned: 0,
  referralBonusCredits: 3,
};

/**
 * Los tres endpoints + `/me` piden `tenant.findUnique` con selects distintos.
 * Se despacha por las columnas pedidas para que el mismo mock sirva a todos.
 */
function tenantPorSelect(select: Record<string, unknown> | undefined) {
  if (select?.shipmentCredits) return WALLET; // el wallet del credit-holder
  if (select?.shopifyStoreUrl) {
    return { id: 'tenant-1', name: 'Kaia', userId: 'u1', ...tiendaActual };
  }
  if (select?.userId) return { userId: 'u1' }; // getCreditHolderTenantId
  return null;
}

function pedirPackMercadoPago() {
  return packMercadoPago(new NextRequest(`https://autoenvia.com/api/credit-packs/checkout?pack=${PACK}`));
}
function pedirPackWhop() {
  return packWhop(new NextRequest(`https://autoenvia.com/api/credit-packs/whop-checkout?pack=${PACK}`));
}
function pedirSuscripcion() {
  return suscripcionMercadoPago(new NextRequest('https://autoenvia.com/api/mercadopago/checkout?plan=starter'));
}

function pedirRecover() {
  // Sin querystring ni body: este GET no recibe nada. Alcanza con estar logueado.
  return suscripcionRecover();
}

const RIELES: Array<{ nombre: string; pedir: () => Promise<Response> }> = [
  { nombre: 'POST de packs por MercadoPago (/api/credit-packs/checkout)', pedir: pedirPackMercadoPago },
  { nombre: 'packs por Whop (/api/credit-packs/whop-checkout)', pedir: pedirPackWhop },
  { nombre: 'suscripción mensual (/api/mercadopago/checkout)', pedir: pedirSuscripcion },
  { nombre: 'suscripción de Recover (/api/recover/subscribe)', pedir: pedirRecover },
];

beforeEach(() => {
  vi.clearAllMocks();
  tiendaActual = TIENDA_PROPIA;
  process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';
  process.env.WHOP_CHECKOUT_URLS = JSON.stringify({ [PACK]: WHOP_URL });
  process.env.RECOVER_MERCADOPAGO_PLAN_ID = 'plan_recover_1';
  mocks.getAuthenticatedTenant.mockResolvedValue({ userId: 'u1', tenantId: 'tenant-1' });
  mocks.tenantFindUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
    tenantPorSelect(args?.select),
  );
  mocks.tenantFindFirst.mockResolvedValue({ id: 'tenant-1' });
  mocks.tenantFindMany.mockResolvedValue([{ id: 'tenant-1' }]);
  mocks.userFindUnique.mockResolvedValue({ email: 'kaia@tienda.uy', name: 'Kaia' });
  mocks.purchaseCreate.mockResolvedValue({ id: 'cp_1' });
  mocks.purchaseUpdate.mockResolvedValue({});
  mocks.purchaseFindFirst.mockResolvedValue(null);
  mocks.purchaseFindMany.mockResolvedValue([]);
  mocks.preferenceCreate.mockResolvedValue({ id: 'pref_1', init_point: 'https://mp.test/pref_1' });
  mocks.preApprovalCreate.mockResolvedValue({ init_point: 'https://mp.test/preapproval_1' });
});

afterEach(() => {
  delete process.env.WHOP_CHECKOUT_URLS;
  delete process.env.RECOVER_MERCADOPAGO_PLAN_ID;
});

describe('🔴 tienda que entró por Shopify: los rieles off-platform están CERRADOS', () => {
  beforeEach(() => {
    tiendaActual = TIENDA_SHOPIFY;
  });

  for (const riel of RIELES) {
    it(`${riel.nombre} → 409`, async () => {
      const res = await riel.pedir();
      expect(res.status).toBe(409);
    });

    it(`${riel.nombre} → el 409 dice que paga por Shopify y a dónde ir`, async () => {
      const body = await (await riel.pedir()).json();
      expect(body.error).toMatch(/Shopify/);
      expect(body.code).toBe('SHOPIFY_BILLING_ONLY');
      expect(body.checkoutUrl).toBe('/api/credit-packs/shopify-checkout');
    });

    it(`${riel.nombre} → no crea compra ni habla con el cobrador`, async () => {
      await riel.pedir();
      // Fail-closed: el corte va ANTES de tocar la base o la API del cobrador.
      expect(mocks.purchaseCreate).not.toHaveBeenCalled();
      expect(mocks.preferenceCreate).not.toHaveBeenCalled();
      expect(mocks.preApprovalCreate).not.toHaveBeenCalled();
    });
  }

  it('el corte no depende de que Whop tenga link configurado', async () => {
    // Sin la env, el endpoint contestaba 404 "no disponible" ANTES de mirar el
    // riel. El día que alguien configure ese link se reabría solo.
    delete process.env.WHOP_CHECKOUT_URLS;
    expect((await pedirPackWhop()).status).toBe(409);
  });

  it('el corte de Recover no depende de que el plan esté configurado', async () => {
    // Mismo fail-closed: sin `RECOVER_MERCADOPAGO_PLAN_ID` el endpoint contesta
    // 503 "no configurada". Si el corte quedara detrás de ese chequeo, el día
    // que alguien cargue el plan el riel se reabre solo para una tienda de
    // Shopify — y ese riel cobra TODOS LOS MESES.
    delete process.env.RECOVER_MERCADOPAGO_PLAN_ID;
    expect((await pedirRecover()).status).toBe(409);
  });
});

describe('tienda de carga propia / DEPO: sigue cobrando como siempre', () => {
  it('packs por MercadoPago redirige al init_point', async () => {
    const res = await pedirPackMercadoPago();
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('location')).toBe('https://mp.test/pref_1');
    expect(mocks.preferenceCreate).toHaveBeenCalledTimes(1);
  });

  it('packs por Whop redirige al link del pack', async () => {
    const res = await pedirPackWhop();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(WHOP_URL);
    expect(mocks.purchaseCreate).toHaveBeenCalledTimes(1);
  });

  it('la suscripción mensual sigue creando la PreApproval', async () => {
    const res = await pedirSuscripcion();
    expect(res.headers.get('location')).toBe('https://mp.test/preapproval_1');
    expect(mocks.preApprovalCreate).toHaveBeenCalledTimes(1);
  });

  it('la suscripción de Recover sigue creando la PreApproval de $490/mes', async () => {
    const res = await pedirRecover();
    expect(res.headers.get('location')).toBe('https://mp.test/preapproval_1');
    expect(mocks.preApprovalCreate).toHaveBeenCalledTimes(1);
    // El plan y el monto son los de siempre: el corte no los tocó.
    const body = mocks.preApprovalCreate.mock.calls[0][0].body;
    expect(body.preapproval_plan_id).toBe('plan_recover_1');
    expect(body.auto_recurring.transaction_amount).toBe(490);
    expect(body.external_reference).toBe('tenant-1|recover');
  });
});

/**
 * La regla vive en un solo lugar conceptual (`shopifyStoreUrl && shopifyToken`
 * sobre el tenant que ORIGINA la compra). Este bloque falla si alguien la
 * afloja en un endpoint y no en `/me`, que es lo que la pantalla lee.
 */
describe('paridad con la bandera `shopifyBilling` de /api/credit-packs/me', () => {
  const CASOS: Array<[string, Tienda]> = [
    ['las dos columnas → cobra Shopify', TIENDA_SHOPIFY],
    ['ninguna → cobra MercadoPago/Whop', TIENDA_PROPIA],
    ['sólo la URL, sin token → NO cobra Shopify', SOLO_URL],
    ['sólo el token, sin URL → NO cobra Shopify', SOLO_TOKEN],
  ];

  for (const [nombre, tienda] of CASOS) {
    it(nombre, async () => {
      tiendaActual = tienda;
      const { data } = await (await creditPacksMe()).json();
      const banderaDeLaPantalla: boolean = data.shopifyBilling;

      for (const riel of RIELES) {
        const res = await riel.pedir();
        expect(
          res.status === 409,
          `${riel.nombre}: server ${res.status} vs pantalla shopifyBilling=${banderaDeLaPantalla}`,
        ).toBe(banderaDeLaPantalla);
      }
    });
  }
});


/**
 * 🔴 EL RIEL QUE NO ES UN ENDPOINT: la invitación a cerrar por WhatsApp.
 *
 * Cortar los cuatro GET no alcanza si la pantalla sigue diciendo «el precio se
 * arma a medida: escribinos por WhatsApp y lo cerramos». Ese cartel
 * (`needsCustomQuote`, volúmenes por encima del paquete más grande comprable)
 * se renderizaba igual con `shopifyBilling === true`: un precio pactado por
 * WhatsApp y cobrado afuera es exactamente el cobro off-platform que prohíbe
 * el requisito 1.2.1 — con el agravante de que la invitación está escrita
 * adentro de la app que el revisor mira.
 *
 * El volumen se fuerza por prop porque el render es estático: el selector
 * arranca en 100 y sin eventos nunca llega al escalón donde aparece el cartel.
 */
describe('🔴 el cartel de volumen alto no invita a cobrar afuera', () => {
  // 2.500 > el paquete más grande comprable con `largePacks: false` (1.000),
  // que es lo que enciende `needsCustomQuote`.
  const VOLUMEN_ALTO = 2500;

  function render(shopifyBilling: boolean) {
    return renderToStaticMarkup(
      createElement(VolumeSelector, {
        usdUyuRateMilli: 40_000,
        usdUyuRateLabel: '40',
        largePacks: false,
        whopPacks: [],
        loadingPackId: null,
        onPayMercadoPago: vi.fn(),
        onPayWhop: vi.fn(),
        shopifyBilling,
        onPayShopify: vi.fn(),
        currency: 'USD' as const,
        onCurrencyChange: vi.fn(),
        initialVolume: VOLUMEN_ALTO,
      }),
    );
  }

  it('con cobro por Shopify no manda a WhatsApp ni ofrece precio a medida', () => {
    const html = render(true);
    expect(html).not.toContain('WhatsApp');
    expect(html).not.toContain('se arma a medida');
    expect(html).not.toContain('escribinos');
  });

  it('con cobro por Shopify igual se dice que no hay un paquete único', () => {
    // El comerciante necesita entender por qué el pack no le cubre el mes; lo
    // que se saca es la salida de la plataforma, no la información.
    const html = render(true);
    expect(html).toContain('no hay un paquete único');
    expect(html).toContain('factura de tu tienda de Shopify');
  });

  it('sin Shopify el cartel de siempre queda intacto', () => {
    // Al comerciante de carga propia / DEPO se le sigue ofreciendo la
    // cotización a medida: ahí no hay plataforma de por medio.
    const html = render(false);
    expect(html).toContain('se arma a medida');
    expect(html).toContain('WhatsApp');
  });

  it('el cartel sólo existe en el escalón alto', () => {
    // Guarda contra "lo arreglé sacando el bloque entero": con el volumen por
    // defecto no aparece en ninguno de los dos modos.
    for (const flag of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(VolumeSelector, {
          usdUyuRateMilli: 40_000,
          usdUyuRateLabel: '40',
          largePacks: false,
          whopPacks: [],
          loadingPackId: null,
          onPayMercadoPago: vi.fn(),
          onPayWhop: vi.fn(),
          shopifyBilling: flag,
          onPayShopify: vi.fn(),
          currency: 'USD' as const,
          onCurrencyChange: vi.fn(),
        }),
      );
      expect(html, `shopifyBilling=${flag}`).not.toContain('se arma a medida');
      expect(html, `shopifyBilling=${flag}`).not.toContain('no hay un paquete único');
    }
  });
});
