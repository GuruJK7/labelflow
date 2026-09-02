/**
 * Catálogo de compra de envíos — precios en DÓLARES (D35), cobro en pesos.
 *
 * Los precios NO viven acá: viven en `lib/pricing.ts` (la escalera de ocho
 * escalones en milésimos de USD). Este módulo sólo arma el catálogo comprable
 * a partir de esa escalera y lo convierte a pesos al tipo de cambio vigente,
 * que es lo que MercadoPago necesita para cobrar.
 *
 * COMPATIBILIDAD CON LO YA VENDIDO. `CreditPurchase.packId` es un string
 * persistido en compras viejas: `pack_10`, `pack_50`, `pack_100`, `pack_250`,
 * `pack_500`, `pack_1000`. Los seis siguen existiendo con el mismo id y la
 * misma cantidad de envíos, así que ninguna compra histórica queda huérfana ni
 * cambia de significado — lo único que cambia es el precio de las compras
 * NUEVAS. Las filas viejas guardan su propio `pricePerShipmentUyu` /
 * `totalPriceUyu`, que es lo que muestra el historial: no se recalculan.
 * `pack_2500` y `pack_5000` son ids nuevos; nada los lee hacia atrás.
 *
 * Welcome bonus: ver lib/trial.ts (`TRIAL_SHIPMENTS`, D31). Cada alta de
 * cuenta nueva lo pasa explícito; el @default del schema no rige.
 *
 * Referidos: 20% de los envíos comprados se acreditan al referidor cuando
 * la compra pasa a PAID.
 *
 * Sin caducidad: los créditos no expiran. Si hay refund/chargeback, el
 * webhook de MP intenta debitar; si el saldo ya se gastó, queda en log.
 */

import {
  PRICING_TIERS,
  type PricingTier,
  getUsdUyuRateMilli,
  periodTotalUsdMilli,
  effectiveUnitUsdMilli,
  unitPriceUsdMilliFor,
  nextTierHint,
  tierFor,
  usdMilliToUyuWhole,
  divRoundHalfUp,
} from './pricing';

export const REFERRAL_KICKBACK_RATE = 0.2; // 20% al referidor

export interface CreditPack {
  id: string;
  shipments: number;
  /** Precio por envío en milésimos de USD. Es el precio AUTORITATIVO. */
  pricePerShipmentUsdMilli: number;
  /** Total del pack en milésimos de USD. */
  totalPriceUsdMilli: number;
  /**
   * Total en PESOS ENTEROS al tipo de cambio vigente. Es el monto que se le
   * cobra a MercadoPago y el que se guarda en la compra. Derivado, no fijo:
   * si cambia `USD_UYU_RATE`, cambia.
   */
  totalPriceUyu: number;
  /**
   * Precio por envío en pesos, con dos decimales, SÓLO para mostrar. Sale de
   * dividir el total ya redondeado, así que `precio × envíos` puede no dar el
   * total exacto: el total manda.
   */
  pricePerShipmentUyu: number;
  label: string; // texto humano para UI
}

/**
 * Cantidades comprables. Los seis primeros son los packs históricos (sus ids
 * están persistidos en compras reales y no se tocan); 2500 y 5000 acompañan
 * los dos escalones nuevos de D35.
 */
export const PACK_SHIPMENTS = [10, 50, 100, 250, 500, 1000, 2500, 5000] as const;

export type CreditPackId = `pack_${(typeof PACK_SHIPMENTS)[number]}`;

/** Ids que ya existían antes de D35 y pueden estar persistidos en compras. */
export const LEGACY_PACK_IDS: readonly string[] = Object.freeze([
  'pack_10',
  'pack_50',
  'pack_100',
  'pack_250',
  'pack_500',
  'pack_1000',
]);

function packIdFor(shipments: number): string {
  return `pack_${shipments}`;
}

function buildPack(shipments: number, rateMilli: bigint): CreditPack {
  const totalUsdMilli = periodTotalUsdMilli(shipments);
  const totalPriceUyu = usdMilliToUyuWhole(totalUsdMilli, rateMilli);
  return {
    id: packIdFor(shipments),
    shipments,
    pricePerShipmentUsdMilli: Number(effectiveUnitUsdMilli(shipments)),
    totalPriceUsdMilli: Number(totalUsdMilli),
    totalPriceUyu,
    // Dos decimales sobre el total ya redondeado a pesos: es display.
    pricePerShipmentUyu:
      Number(divRoundHalfUp(BigInt(totalPriceUyu) * 100n, BigInt(shipments))) / 100,
    label: `${shipments.toLocaleString('es-UY')} envíos`,
  };
}

/**
 * El catálogo depende del tipo de cambio, así que es una FUNCIÓN, no una
 * constante congelada al importar: una env var que cambia en Vercel tiene que
 * verse en el siguiente request sin redeploy.
 *
 * `rateMilli` se pasa explícito desde el CLIENTE. `USD_UYU_RATE` es una env de
 * servidor: en el bundle del navegador `process.env` viene vacío y el default
 * caería en el tipo base sin avisar, mostrando un precio en pesos que no es el
 * que se va a cobrar. Por eso la UI recibe el tipo por la API y lo pasa acá.
 */
export function listPacks(rateMilli: bigint = getUsdUyuRateMilli()): CreditPack[] {
  return PACK_SHIPMENTS.map((n) => buildPack(n, rateMilli));
}

/**
 * Validación defensiva: el id debe existir en el catálogo. Esto previene que
 * un cliente manipule el parámetro `pack` y reciba créditos a precio rebajado
 * — el precio SIEMPRE se recalcula acá, nunca llega del request.
 */
export function getPack(
  packId: string,
  rateMilli: bigint = getUsdUyuRateMilli(),
): CreditPack | null {
  const m = /^pack_(\d+)$/.exec(packId);
  if (!m) return null;
  const shipments = Number(m[1]);
  if (!(PACK_SHIPMENTS as readonly number[]).includes(shipments)) return null;
  // El id tiene que ser el canónico: `pack_010` parsea a 10 y devolvería el
  // pack de 10 con OTRO id del que vino, que es el que termina guardado en la
  // compra. No es un agujero de precio (el precio se recalcula acá), pero sí
  // una forma de ensuciar `CreditPurchase.packId` con variantes.
  if (packIdFor(shipments) !== packId) return null;
  return buildPack(shipments, rateMilli);
}

/** Lista de ids válidos, para mensajes de error. */
export function packIdList(): string {
  return PACK_SHIPMENTS.map(packIdFor).join(', ');
}

/**
 * Cuánto se le acredita al referidor por una compra de N envíos.
 * Math.floor para evitar fracciones — si compras pack_10 (10 envíos), el
 * referidor recibe 2; si compras pack_50 (50 envíos), recibe 10.
 */
export function calcReferralKickback(shipmentsPurchased: number): number {
  if (!Number.isFinite(shipmentsPurchased) || shipmentsPurchased <= 0) return 0;
  return Math.floor(shipmentsPurchased * REFERRAL_KICKBACK_RATE);
}

// ---------------------------------------------------------------------------
// Selector por volumen (D34, reexpresado en dólares por D35):
// "¿Cuántos envíos hacés por mes?"
// ---------------------------------------------------------------------------

export const VOLUME_PRESETS = [50, 100, 250, 500, 1000, 2500, 5000] as const;

export const MAX_MONTHLY_SHIPMENTS = 100_000;

/** Los ocho escalones, listos para renderizar. Precio en USD; total en pesos. */
export interface PricingStep {
  minShipments: number;
  label: string;
  unitPriceUsdMilli: number;
  /** Total del mes en el piso del escalón, en pesos enteros. */
  totalAtStepUyu: number;
  totalAtStepUsdMilli: number;
}

export function listPricingSteps(rateMilli: bigint = getUsdUyuRateMilli()): PricingStep[] {
  return PRICING_TIERS.map((t: PricingTier) => {
    const totalUsdMilli = periodTotalUsdMilli(Math.max(t.minShipments, 1));
    return {
      minShipments: t.minShipments,
      label: t.label,
      unitPriceUsdMilli: Number(t.unitPriceUsdMilli),
      totalAtStepUsdMilli: Number(totalUsdMilli),
      totalAtStepUyu: usdMilliToUyuWhole(totalUsdMilli, rateMilli),
    };
  });
}

export interface VolumeQuote {
  monthlyShipments: number;
  /** Pack recomendado: el más chico que cubre el volumen (el mayor si se pasa). */
  pack: CreditPack;
  /** > 1 sólo si el volumen supera el pack más grande. */
  quantity: number;
  /** Precio de LISTA por envío del escalón en el que cae el volumen (USD milésimos). */
  listUnitUsdMilli: number;
  /** Precio EFECTIVO por envío del mes declarado (USD milésimos). */
  effectiveUnitUsdMilli: number;
  /** Total del mes declarado, en USD milésimos y en pesos enteros. */
  monthlyTotalUsdMilli: number;
  monthlyTotalUyu: number;
  /** Lo que se paga por el pack recomendado × cantidad. */
  totalPriceUsdMilli: number;
  totalPriceUyu: number;
  tierLabel: string;
  /** true si el volumen declarado ya paga el techo de un escalón mejor. */
  cappedByBetterTier: boolean;
  /** Ahorro mensual frente al precio del primer escalón (USD milésimos). */
  savingsVsBaseUsdMilli: number;
  /** Empujón al escalón siguiente. null en el último escalón. */
  nextStep: {
    minShipments: number;
    label: string;
    shipmentsMore: number;
    /** Ahorro REAL por envío (efectivo contra efectivo). Puede ser 0. */
    savesPerShipmentUsdMilli: number;
    unitPriceUsdMilli: number;
    totalAtStepUsdMilli: number;
    totalAtStepUyu: number;
  } | null;
  /** Tipo de cambio con el que se calcularon los pesos, en milésimos. */
  usdUyuRateMilli: number;
}

function assertVolume(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_MONTHLY_SHIPMENTS) {
    throw new RangeError(
      `Volumen mensual inválido: ${n} (entero entre 1 y ${MAX_MONTHLY_SHIPMENTS})`,
    );
  }
}

/**
 * La cotización que ve el usuario. Dos números distintos a propósito:
 *
 *   - `monthlyTotal*` es lo que le costaría el mes con el volumen que declaró.
 *     Es el número honesto del simulador.
 *   - `totalPrice*` es lo que va a pagar si aprieta comprar: el pack más chico
 *     que lo cubre. Puede ser mayor porque los packs vienen en cantidades
 *     fijas y lo que sobra queda para el mes siguiente.
 */
export function quoteForVolume(
  monthlyShipments: number,
  rateMilli: bigint = getUsdUyuRateMilli(),
): VolumeQuote {
  assertVolume(monthlyShipments);
  const packs = listPacks(rateMilli);
  const largest = packs[packs.length - 1];

  let pack = packs.find((p) => p.shipments >= monthlyShipments) ?? largest;
  let quantity = 1;
  if (monthlyShipments > largest.shipments) {
    pack = largest;
    quantity = Math.ceil(monthlyShipments / largest.shipments);
  }

  const monthlyTotalUsdMilli = periodTotalUsdMilli(monthlyShipments);
  const listUnit = unitPriceUsdMilliFor(monthlyShipments);
  const totalUsdMilli = BigInt(pack.totalPriceUsdMilli) * BigInt(quantity);
  const baseUnit = PRICING_TIERS[0].unitPriceUsdMilli;

  const next = nextTierHint(monthlyShipments);

  return {
    monthlyShipments,
    pack,
    quantity,
    listUnitUsdMilli: Number(listUnit),
    effectiveUnitUsdMilli: Number(effectiveUnitUsdMilli(monthlyShipments)),
    monthlyTotalUsdMilli: Number(monthlyTotalUsdMilli),
    monthlyTotalUyu: usdMilliToUyuWhole(monthlyTotalUsdMilli, rateMilli),
    totalPriceUsdMilli: Number(totalUsdMilli),
    totalPriceUyu: usdMilliToUyuWhole(totalUsdMilli, rateMilli),
    tierLabel: tierFor(monthlyShipments).label,
    cappedByBetterTier: monthlyTotalUsdMilli < BigInt(monthlyShipments) * listUnit,
    savingsVsBaseUsdMilli: Number(BigInt(monthlyShipments) * baseUnit - monthlyTotalUsdMilli),
    nextStep: next
      ? {
          minShipments: next.tier.minShipments,
          label: next.tier.label,
          shipmentsMore: next.shipmentsMore,
          savesPerShipmentUsdMilli: Number(next.savesPerShipmentUsdMilli),
          unitPriceUsdMilli: Number(next.tier.unitPriceUsdMilli),
          totalAtStepUsdMilli: Number(next.totalAtTierUsdMilli),
          totalAtStepUyu: usdMilliToUyuWhole(next.totalAtTierUsdMilli, rateMilli),
        }
      : null,
    usdUyuRateMilli: Number(rateMilli),
  };
}

/** Etiqueta del escalón para un volumen dado. Se mantiene por compatibilidad. */
export function tierLabelFor(monthlyShipments: number): string {
  assertVolume(monthlyShipments);
  return tierFor(monthlyShipments).label;
}
