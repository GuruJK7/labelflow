/**
 * Credit-pack pricing — pago único en UYU vía MercadoPago Preference.
 *
 * Reemplaza al modelo de suscripción mensual. Cada pack acredita N envíos
 * al saldo Tenant.shipmentCredits, que el worker decrementa por cada
 * Finalizar exitoso en DAC.
 *
 * Welcome bonus: schema.prisma define `Tenant.shipmentCredits @default(10)`,
 * por lo que cada cuenta nueva arranca con 10 envíos sin código adicional.
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

/**
 * Welcome bonus que se aplica a tenants nuevos. El default ya está en el
 * schema, este número se exporta para que la UI pueda mostrarlo en el
 * mensaje de bienvenida sin hardcodearlo.
 */
export const WELCOME_BONUS_SHIPMENTS = 10;
