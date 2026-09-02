import { shopifyGraphql } from '@/lib/shopify-graphql';

/**
 * Cobro por la Billing API de Shopify — CARGO ÚNICO.
 *
 * POR QUÉ EXISTE
 * --------------
 * Requisito 1.2 del App Store, textual: «Apps that use off-platform billing
 * cannot be distributed through the Shopify App store, unless you've been
 * notified otherwise by Shopify». Las cuatro excepciones documentadas
 * (sourcing de productos, donaciones, pasarelas de pago, facilitadores de
 * pago) no cubren logística. O sea: el comerciante que instala desde el App
 * Store NO puede pagar por MercadoPago, y la ficha no se puede enviar a
 * revisión mientras el producto cobre así.
 *
 * POR QUÉ CARGO ÚNICO Y NO SUSCRIPCIÓN
 * ------------------------------------
 * El producto vende PACKS PREPAGOS: se compran envíos, se descuenta uno por
 * guía emitida y no vencen. `appPurchaseOneTimeCreate` es exactamente eso —
 * un cargo único en la factura del comerciante— así que el modelo no cambia:
 * el mismo pack, la misma escalera de D35, el mismo precio en dólares. Copiar
 * la suscripción mensual de la competencia habría sido cambiar el producto
 * para encajar en la API, no al revés.
 *
 * QUÉ NO CAMBIA. El comerciante que entra por el camino del Excel/Dashboard
 * no usa la app de Shopify, así que sigue pagando por MercadoPago o Whop. La
 * regla de Shopify aplica a quien usa la app.
 *
 * MONEDA. Shopify cobra en USD y la escalera ya está denominada en USD
 * (D35): este riel no toca `USD_UYU_RATE` ni convierte nada, así que no tiene
 * el riesgo de tipo de cambio del riel de MercadoPago.
 *
 * CONTRATO VERIFICADO EN LA DOC (2026-09-02)
 *   - `appPurchaseOneTimeCreate(name, price: MoneyInput!, returnUrl: URL!, test: Boolean)`
 *     devuelve `{ appPurchaseOneTime { id status }, confirmationUrl, userErrors }`.
 *   - `AppPurchaseStatus`: PENDING (esperando al comerciante), ACTIVE
 *     (aprobado y COBRADO), DECLINED, EXPIRED (no aceptado en dos días),
 *     ACCEPTED (deprecado). Sólo ACTIVE acredita.
 *   - Webhook `APP_PURCHASES_ONE_TIME_UPDATE` cuando cambia el estado.
 */

export const APP_PURCHASE_ONE_TIME_CREATE = `mutation AutoEnviaAppPurchaseOneTimeCreate(
  $name: String!
  $price: MoneyInput!
  $returnUrl: URL!
  $test: Boolean
) {
  appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
    appPurchaseOneTime { id status }
    confirmationUrl
    userErrors { field message }
  }
}`;

export const APP_PURCHASE_ONE_TIME_QUERY = `query AutoEnviaAppPurchaseOneTime($id: ID!) {
  node(id: $id) {
    ... on AppPurchaseOneTime {
      id
      status
      name
    }
  }
}`;

/**
 * ¿La tienda es de desarrollo? Decide el flag `test` del cargo.
 *
 * 🔴 IMPORTA PARA LA REVISIÓN. Shopify prueba la app en una tienda de
 * desarrollo: si el cargo no fuera de prueba, el revisor tendría que aprobar
 * un cobro real para poder testear, y la aprobación fallaría. Con `test:true`
 * el flujo es idéntico y no se cobra. Se consulta en vez de leerse de una env
 * para que no dependa de que alguien se acuerde de apagarla en producción:
 * una env mal puesta cobraría de verdad a un revisor, o regalaría el producto
 * a todo el mundo.
 */
export const SHOP_PLAN_QUERY = `query AutoEnviaShopPlan {
  shop { plan { partnerDevelopment shopifyPlus } }
}`;

export type AppPurchaseStatus = 'PENDING' | 'ACTIVE' | 'DECLINED' | 'EXPIRED' | 'ACCEPTED';

/** Sólo ACTIVE significa "el comerciante aprobó y Shopify ya le cobró". */
export function isPaidStatus(status: string | null | undefined): boolean {
  return status === 'ACTIVE';
}

/** Estados terminales que no van a acreditar nunca: la compra se marca FAILED. */
export function isDeadStatus(status: string | null | undefined): boolean {
  return status === 'DECLINED' || status === 'EXPIRED';
}

export class ShopifyBillingError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'ShopifyBillingError';
  }
}

/**
 * Milésimos de dólar → el string de dos decimales que espera `MoneyInput`.
 *
 * 🔴 REDONDEO EXPLÍCITO Y RUIDOSO. La escalera vive en milésimos y Shopify
 * cobra en centavos: un pack cuyo total no cierre en centavos redondos se
 * cobraría distinto de lo que dice la pantalla. Hoy los ocho escalones dan
 * totales exactos (250 × 0,300 = 75,00), y hay un test que recorre el
 * catálogo entero y falla si alguno deja de cerrar. Si algún día uno no
 * cierra, esto redondea half-up y el test avisa: no se rompe el cobro en
 * silencio.
 */
export function usdMilliToAmountString(usdMilli: number): string {
  if (!Number.isFinite(usdMilli) || usdMilli < 0) {
    throw new RangeError(`usdMilliToAmountString: monto inválido ${usdMilli}`);
  }
  const cents = Math.round(usdMilli / 10);
  return (cents / 100).toFixed(2);
}

/** `true` si el total NO cae en un centavo exacto (o sea, si hubo que redondear). */
export function needsRounding(usdMilli: number): boolean {
  return Math.round(usdMilli) % 10 !== 0;
}

export interface CreateChargeInput {
  shop: string;
  accessToken: string;
  /** Lo que el comerciante ve en su factura de Shopify. */
  name: string;
  totalUsdMilli: number;
  returnUrl: string;
  /** `true` en tiendas de desarrollo: mismo flujo, sin cobro. */
  test: boolean;
}

export interface CreatedCharge {
  chargeId: string;
  confirmationUrl: string;
  status: AppPurchaseStatus;
}

export async function createOneTimeCharge(input: CreateChargeInput): Promise<CreatedCharge> {
  const res = await shopifyGraphql<{
    appPurchaseOneTimeCreate: {
      appPurchaseOneTime: { id: string; status: AppPurchaseStatus } | null;
      confirmationUrl: string | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    } | null;
  }>(input.shop, input.accessToken, APP_PURCHASE_ONE_TIME_CREATE, {
    name: input.name,
    price: { amount: usdMilliToAmountString(input.totalUsdMilli), currencyCode: 'USD' },
    returnUrl: input.returnUrl,
    test: input.test,
  });

  if (res.status !== 200 || !res.data) {
    throw new ShopifyBillingError(
      'Shopify no pudo crear el cargo',
      `status=${res.status} errors=${JSON.stringify(res.errors ?? []).slice(0, 300)}`,
    );
  }

  const payload = res.data.appPurchaseOneTimeCreate;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new ShopifyBillingError(
      'Shopify rechazó el cargo',
      userErrors.map((e) => `${(e.field ?? []).join('.')}: ${e.message}`).join(' | ').slice(0, 300),
    );
  }

  const charge = payload?.appPurchaseOneTime;
  const confirmationUrl = payload?.confirmationUrl;
  if (!charge?.id || !confirmationUrl) {
    throw new ShopifyBillingError('Shopify no devolvió confirmationUrl');
  }

  return { chargeId: charge.id, confirmationUrl, status: charge.status };
}

/** Estado actual del cargo. Se usa en el retorno del comerciante, sin esperar el webhook. */
export async function fetchChargeStatus(
  shop: string,
  accessToken: string,
  chargeId: string,
): Promise<AppPurchaseStatus | null> {
  const res = await shopifyGraphql<{ node: { id: string; status: AppPurchaseStatus } | null }>(
    shop,
    accessToken,
    APP_PURCHASE_ONE_TIME_QUERY,
    { id: chargeId },
  );
  if (res.status !== 200 || !res.data?.node) return null;
  return res.data.node.status;
}

/** `true` si la tienda es de desarrollo (el cargo va como `test`). */
export async function isDevelopmentStore(shop: string, accessToken: string): Promise<boolean> {
  const res = await shopifyGraphql<{ shop: { plan: { partnerDevelopment: boolean } } }>(
    shop,
    accessToken,
    SHOP_PLAN_QUERY,
  );
  // Ante la duda NO se marca como prueba: errar para el lado de cobrar de
  // verdad es preferible a regalar el producto por un error de red.
  return res.status === 200 && res.data?.shop?.plan?.partnerDevelopment === true;
}
