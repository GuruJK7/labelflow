/**
 * Tarifario por volumen — núcleo puro, sin DB ni I/O.
 *
 * UNIDAD DE CUENTA: milésimos de peso uruguayo, como `bigint`.
 * 1 UYU = 1000n. Nunca float: los redondeos de coma flotante sobre plata
 * son la forma más aburrida de perder dinero.
 *
 * DECISIÓN DE DISEÑO (la que mata el arbitraje):
 * el monedero se denomina en PLATA, no en envíos, y el descuento por volumen
 * se aplica AL CONSUMIR, no al comprar. Consecuencias:
 *
 *   - Comprar = depositar plata. No hay "packs" con precio congelado que
 *     después haya que revaluar.
 *   - El saldo sobrante es plata y punto: se puede gastar en AutoBoost sin
 *     ninguna tasa de conversión, y por lo tanto sin nada que arbitrar.
 *   - Un reintegro devuelve exactamente lo que el período recalcula, nunca
 *     un precio de lista viejo. Ver `settle.ts`.
 *
 * La alternativa (packs con descuento al comprar) abre el agujero que
 * encontró la revisión adversarial del 2026-09-01: con rebate retroactivo
 * más reintegro al precio bruto, un depósito de 7.000 UYU podía terminar
 * en 12.087 UYU de saldo acreditado.
 */

export const MILLI = 1000n;

/** Convierte pesos enteros a milésimos. Sólo para constantes y tests. */
export function uyu(pesos: number): bigint {
  if (!Number.isInteger(pesos)) {
    throw new RangeError(`uyu() espera pesos enteros, recibió ${pesos}`);
  }
  return BigInt(pesos) * MILLI;
}

export interface Tier {
  /** Volumen mensual a partir del cual aplica este precio. */
  readonly minShipments: number;
  /** Precio por envío, en milésimos de UYU. */
  readonly unitPriceMilli: bigint;
  /** Etiqueta para UI y recibos. */
  readonly label: string;
}

/**
 * Tarifario vigente. Los precios salen 1:1 de `apps/web/lib/credit-packs.ts`
 * (20/17/15/12/10/7 UYU por envío) para que la migración no cambie ningún
 * precio: lo único que cambia es CUÁNDO se aplica el descuento.
 *
 * Debe quedar ordenado por minShipments ascendente. `assertTiersValid()` lo
 * verifica y corre al importar el módulo.
 */
export const TIERS: readonly Tier[] = Object.freeze([
  { minShipments: 0, unitPriceMilli: uyu(20), label: 'Hasta 49 envíos/mes' },
  { minShipments: 50, unitPriceMilli: uyu(17), label: 'Desde 50 envíos/mes' },
  { minShipments: 100, unitPriceMilli: uyu(15), label: 'Desde 100 envíos/mes' },
  { minShipments: 250, unitPriceMilli: uyu(12), label: 'Desde 250 envíos/mes' },
  { minShipments: 500, unitPriceMilli: uyu(10), label: 'Desde 500 envíos/mes' },
  { minShipments: 1000, unitPriceMilli: uyu(7), label: 'Desde 1000 envíos/mes' },
]);

/** Valida el invariante estructural del tarifario. Corre al importar. */
export function assertTiersValid(tiers: readonly Tier[] = TIERS): void {
  if (tiers.length === 0) throw new Error('El tarifario no puede estar vacío');
  if (tiers[0].minShipments !== 0) {
    throw new Error('El primer tramo debe arrancar en 0 para cubrir todo volumen');
  }
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minShipments <= tiers[i - 1].minShipments) {
      throw new Error(
        `Tramos desordenados: ${tiers[i - 1].minShipments} → ${tiers[i].minShipments}`,
      );
    }
    if (tiers[i].unitPriceMilli >= tiers[i - 1].unitPriceMilli) {
      throw new Error(
        `El tramo ${tiers[i].minShipments} no es más barato que el anterior; ` +
          'un tarifario por volumen que sube de precio no tiene sentido',
      );
    }
  }
  for (const t of tiers) {
    if (t.unitPriceMilli <= 0n) throw new Error(`Precio no positivo en el tramo ${t.minShipments}`);
  }
}
assertTiersValid();

/** Precio de lista por envío para un volumen mensual dado. */
export function unitPriceFor(n: number, tiers: readonly Tier[] = TIERS): bigint {
  assertCount(n);
  let price = tiers[0].unitPriceMilli;
  for (const t of tiers) {
    if (n >= t.minShipments) price = t.unitPriceMilli;
    else break;
  }
  return price;
}

/** El tramo que aplica a un volumen mensual dado. */
export function tierFor(n: number, tiers: readonly Tier[] = TIERS): Tier {
  assertCount(n);
  let tier = tiers[0];
  for (const t of tiers) {
    if (n >= t.minShipments) tier = t;
    else break;
  }
  return tier;
}

/**
 * Lo que cuesta el mes entero con `n` envíos facturables.
 *
 * NO es `n × precio(n)`. Es el mínimo entre eso y lo que costaría el mes si
 * el cliente hubiera llegado al piso de cualquier tramo mejor:
 *
 *     total(n) = min sobre todos los tramos t de:  max(n, t.minShipments) × t.unitPrice
 *
 * POR QUÉ. Con `n × precio(n)` a secas, el tarifario tiene cinco ZONAS MUERTAS
 * donde hacer MÁS envíos sale MENOS plata en términos absolutos:
 *
 *     43..49   envíos pagan más que 50   (43×20 = 860  >  50×17 = 850)
 *     89..99   envíos pagan más que 100  (89×17 = 1513 > 100×15 = 1500)
 *     201..249 envíos pagan más que 250  (201×15 = 3015 > 250×12 = 3000)
 *     417..499 envíos pagan más que 500  (417×12 = 5004 > 500×10 = 5000)
 *     701..999 envíos pagan más que 1000 (701×10 = 7010 > 1000×7 = 7000)
 *
 * Un cliente con 800 envíos pagaría 8.000 mientras uno con 1.000 paga 7.000.
 * Eso no es un tarifario, es una trampa: castiga al que está a punto de crecer,
 * y el primero que lo note tiene razón en enojarse.
 *
 * Con el mínimo, `total` queda monótona no decreciente: hacer un envío más
 * nunca puede bajar la factura, y nunca se cobra más que el techo del tramo
 * siguiente. `__tests__/billing-tiers.test.ts` lo verifica exhaustivamente
 * de 0 a 2000.
 */
export function periodTotalMilli(n: number, tiers: readonly Tier[] = TIERS): bigint {
  assertCount(n);
  if (n === 0) return 0n;
  let best: bigint | null = null;
  for (const t of tiers) {
    const billableCount = BigInt(Math.max(n, t.minShipments));
    const candidate = billableCount * t.unitPriceMilli;
    if (best === null || candidate < best) best = candidate;
  }
  return best as bigint;
}

/**
 * Precio efectivo por envío que terminó pagando el cliente este mes.
 * Es lo que va en el recibo y en el dashboard, y lo que hay que usar para
 * cualquier comparación comercial. Devuelve 0n si no hubo envíos.
 */
export function effectiveUnitPriceMilli(n: number, tiers: readonly Tier[] = TIERS): bigint {
  assertCount(n);
  if (n === 0) return 0n;
  return periodTotalMilli(n, tiers) / BigInt(n);
}

/**
 * Lo que hay que mostrar en el simulador de precios (el flujo tipo Escalafy:
 * "¿cuántos envíos hacés por mes?" → "te sale esto").
 */
export interface Quote {
  shipments: number;
  totalMilli: bigint;
  effectiveUnitMilli: bigint;
  tierLabel: string;
  /** true si al cliente le conviene saber que está pagando el techo de un tramo mejor. */
  cappedByBetterTier: boolean;
}

export function quote(n: number, tiers: readonly Tier[] = TIERS): Quote {
  assertCount(n);
  const totalMilli = periodTotalMilli(n, tiers);
  const listTotal = BigInt(n) * unitPriceFor(n, tiers);
  return {
    shipments: n,
    totalMilli,
    effectiveUnitMilli: effectiveUnitPriceMilli(n, tiers),
    tierLabel: tierFor(n, tiers).label,
    cappedByBetterTier: totalMilli < listTotal,
  };
}

function assertCount(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`El volumen de envíos debe ser un entero >= 0, recibió ${n}`);
  }
  if (n > 10_000_000) {
    throw new RangeError(`Volumen implausible (${n}); probable bug de llamador`);
  }
}
