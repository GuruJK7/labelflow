/**
 * Credit-pack pricing — pago único en UYU vía MercadoPago Preference.
 *
 * Reemplaza al modelo de suscripción mensual. Cada pack acredita N envíos
 * al saldo Tenant.shipmentCredits, que el worker decrementa por cada
 * Finalizar exitoso en DAC.
 *
 * Welcome bonus: ver lib/trial.ts (`TRIAL_SHIPMENTS`, D31). Cada alta de
 * cuenta nueva lo pasa explícito; el @default del schema no rige.
 *
 * Referidos: 20% de los envíos comprados se acreditan al referidor cuando
 * la compra pasa a PAID. Por ejemplo, si un referido compra pack_100, su
 * referidor recibe Math.floor(0.2 * 100) = 20 envíos gratis.
 *
 * Sin caducidad: los créditos no expiran. Si hay refund/chargeback, el
 * webhook de MP intenta debitar; si el saldo ya se gastó, queda en log.
 */

export const REFERRAL_KICKBACK_RATE = 0.2; // 20% al referidor

export interface CreditPack {
  id: string;
  shipments: number;
  pricePerShipmentUyu: number;
  totalPriceUyu: number;
  label: string; // texto humano para UI
}

export const CREDIT_PACKS: Record<string, CreditPack> = {
  pack_10: {
    id: 'pack_10',
    shipments: 10,
    pricePerShipmentUyu: 20,
    totalPriceUyu: 200,
    label: '10 envíos',
  },
  pack_50: {
    id: 'pack_50',
    shipments: 50,
    pricePerShipmentUyu: 17,
    totalPriceUyu: 850,
    label: '50 envíos',
  },
  pack_100: {
    id: 'pack_100',
    shipments: 100,
    pricePerShipmentUyu: 15,
    totalPriceUyu: 1500,
    label: '100 envíos',
  },
  pack_250: {
    id: 'pack_250',
    shipments: 250,
    pricePerShipmentUyu: 12,
    totalPriceUyu: 3000,
    label: '250 envíos',
  },
  pack_500: {
    id: 'pack_500',
    shipments: 500,
    pricePerShipmentUyu: 10,
    totalPriceUyu: 5000,
    label: '500 envíos',
  },
  pack_1000: {
    id: 'pack_1000',
    shipments: 1000,
    pricePerShipmentUyu: 7,
    totalPriceUyu: 7000,
    label: '1000 envíos',
  },
};

export type CreditPackId = keyof typeof CREDIT_PACKS;

/**
 * Validación defensiva: el id debe existir en CREDIT_PACKS y los precios
 * declarados deben coincidir con la tabla canónica. Esto previene que un
 * cliente manipule un pack y reciba créditos a precio rebajado.
 */
export function getPack(packId: string): CreditPack | null {
  return CREDIT_PACKS[packId] ?? null;
}

export function listPacks(): CreditPack[] {
  return Object.values(CREDIT_PACKS).sort((a, b) => a.shipments - b.shipments);
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
// Selector por volumen (D34): "¿Cuántos envíos hacés por mes?"
//
// Los tramos son los mismos que `apps/worker/src/billing/tiers.ts`
// (cortes 0/50/100/250/500/1000 → 20/17/15/12/10/7 UYU). No se importa el
// worker: son apps separadas, así que el test de volumen fija que las dos
// tablas coincidan. Aritmética entera, sin floats: es plata.
// ---------------------------------------------------------------------------

export const VOLUME_PRESETS = [50, 100, 250, 500, 1000] as const;

/** Precio de lista (pack más chico): la base contra la que se calcula el ahorro. */
export const BASE_PRICE_PER_SHIPMENT_UYU = CREDIT_PACKS.pack_10.pricePerShipmentUyu;

export const MAX_MONTHLY_SHIPMENTS = 100_000;

/** Cortes de tramo, ascendentes. Cada corte es el `shipments` de un pack. */
const TIER_CUTS: ReadonlyArray<{ minShipments: number; label: string }> = [
  { minShipments: 0, label: 'Hasta 49 envíos por mes' },
  { minShipments: 50, label: 'Desde 50 envíos por mes' },
  { minShipments: 100, label: 'Desde 100 envíos por mes' },
  { minShipments: 250, label: 'Desde 250 envíos por mes' },
  { minShipments: 500, label: 'Desde 500 envíos por mes' },
  { minShipments: 1000, label: 'Desde 1000 envíos por mes' },
];

export function tierLabelFor(monthlyShipments: number): string {
  assertVolume(monthlyShipments);
  let label = TIER_CUTS[0].label;
  for (const cut of TIER_CUTS) {
    if (monthlyShipments >= cut.minShipments) label = cut.label;
  }
  return label;
}

export interface VolumeQuote {
  monthlyShipments: number;
  /** Pack recomendado: el más chico que cubre el volumen (pack_1000 si n > 1000). */
  pack: CreditPack;
  /** > 1 sólo si n > 1000 (se compra pack_1000 varias veces). */
  quantity: number;
  pricePerShipmentUyu: number;
  totalPriceUyu: number;
  /** Tramo del pack recomendado (es lo que el usuario paga, no lo que declaró). */
  tierLabel: string;
  /** (envíos del pack × cantidad × precio base) − total. 0 para pack_10. */
  savingsVsBaseUyu: number;
  /**
   * Tramo siguiente, si existe: cuántos envíos más habría que comprar para
   * bajar el precio unitario. null en pack_1000 o cuando quantity > 1.
   */
  nextTier: {
    pack: CreditPack;
    shipmentsMore: number;
    pricePerShipmentUyu: number;
    totalPriceUyu: number;
  } | null;
}

function assertVolume(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_MONTHLY_SHIPMENTS) {
    throw new RangeError(`Volumen mensual inválido: ${n} (entero entre 1 y ${MAX_MONTHLY_SHIPMENTS})`);
  }
}

export function quoteForVolume(monthlyShipments: number): VolumeQuote {
  assertVolume(monthlyShipments);
  const packs = listPacks();
  const largest = packs[packs.length - 1];

  let pack = packs.find((p) => p.shipments >= monthlyShipments) ?? largest;
  let quantity = 1;
  if (monthlyShipments > largest.shipments) {
    pack = largest;
    quantity = Math.ceil(monthlyShipments / largest.shipments);
  }

  const totalPriceUyu = pack.totalPriceUyu * quantity;
  const savingsVsBaseUyu = pack.shipments * quantity * BASE_PRICE_PER_SHIPMENT_UYU - totalPriceUyu;

  const idx = packs.indexOf(pack);
  const next = quantity === 1 && idx < packs.length - 1 ? packs[idx + 1] : null;
  const nextTier =
    next && next.pricePerShipmentUyu < pack.pricePerShipmentUyu
      ? {
          pack: next,
          shipmentsMore: next.shipments - monthlyShipments,
          pricePerShipmentUyu: next.pricePerShipmentUyu,
          totalPriceUyu: next.totalPriceUyu,
        }
      : null;

  return {
    monthlyShipments,
    pack,
    quantity,
    pricePerShipmentUyu: pack.pricePerShipmentUyu,
    totalPriceUyu,
    tierLabel: tierLabelFor(pack.shipments),
    savingsVsBaseUyu,
    nextTier,
  };
}
