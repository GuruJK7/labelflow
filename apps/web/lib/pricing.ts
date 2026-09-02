/**
 * Tarifario en DÓLARES por volumen mensual — FUENTE ÚNICA (D35).
 *
 * UNIDAD DE CUENTA: milésimos de dólar, como `bigint`. USD 0,50 = 500n.
 * Nunca float: los redondeos de coma flotante sobre plata son la forma más
 * aburrida de perder dinero.
 *
 * POR QUÉ EN DÓLARES. Los costos que sostienen el producto (Render, Supabase,
 * Vercel, los modelos) se pagan en dólares; el precio en pesos se licuaba solo
 * con cada devaluación. Con el precio denominado en USD, el tipo de cambio deja
 * de ser una decisión implícita del calendario y pasa a ser una variable
 * explícita (`USD_UYU_RATE`) que Adrian mueve cuando quiere.
 *
 * QUIÉN CONSUME ESTO
 *   - `lib/credit-packs.ts` — catálogo de compra y el selector por volumen.
 *   - `app/api/credit-packs/checkout/route.ts` — el monto en UYU que cobra
 *     MercadoPago sale de acá, no de una constante suelta.
 *   - `apps/worker/src/billing/tiers.ts` — la misma escalera, en el worker.
 *     Son apps separadas (el worker compila a CJS con `rootDir: src`, no puede
 *     importar fuera de su árbol), así que la tabla está duplicada Y hay un
 *     test que falla si divergen: `lib/__tests__/pricing-worker-sync.test.ts`.
 *   - La landing consume `PRICING_TIERS` + `quoteUsd()` (rama aparte).
 *
 * MONOTONÍA. `periodTotalUsdMilli` es la misma función que ya estaba probada
 * en el worker: el total del mes es el mínimo sobre los tramos de
 * `max(n, t.minShipments) × t.unitPrice`. Sin ese mínimo el tarifario tiene
 * zonas muertas donde hacer UN envío más baja la factura. No se reescribió la
 * lógica: se replicó tal cual y hay un test que compara las dos
 * implementaciones envío por envío.
 */

/** 1 USD = 1000 milésimos. */
export const USD_MILLI = 1000n;

/** 1 UYU = 1000 milésimos. El tipo de cambio también se expresa en milésimos. */
export const UYU_MILLI = 1000n;

export interface PricingTier {
  /** Volumen mensual a partir del cual aplica este precio. */
  readonly minShipments: number;
  /** Precio por envío, en milésimos de USD. */
  readonly unitPriceUsdMilli: bigint;
  /** Etiqueta para UI y recibos. */
  readonly label: string;
}

/**
 * La escalera de D35. Los seis primeros escalones son los precios que ya
 * estaban vigentes en pesos (20/17/15/12/10/7 UYU) llevados a dólares al
 * tipo de cambio base de 40 UYU/USD; los dos últimos (2.500 y 5.000) son
 * nuevos y premian volumen que hoy no existe.
 *
 * 🔴 UNA EXCEPCIÓN a "ningún cliente actual paga más": el escalón de 1.000
 * queda en USD 0,18, y 7 UYU / 40 = 0,175. A tipo 40 ese cliente pasa de 7,00
 * a 7,20 UYU por envío (+2,86 %). Es el único que sube y está medido por
 * `legacyPriceRegressions()`, que tiene su propio test. Si Adrian quiere que
 * la promesa valga sin asterisco, el cambio es una línea: `180n` → `175n`.
 */
export const PRICING_TIERS: readonly PricingTier[] = Object.freeze([
  { minShipments: 0, unitPriceUsdMilli: 500n, label: 'Hasta 49 envíos por mes' },
  { minShipments: 50, unitPriceUsdMilli: 420n, label: 'Desde 50 envíos por mes' },
  { minShipments: 100, unitPriceUsdMilli: 370n, label: 'Desde 100 envíos por mes' },
  { minShipments: 250, unitPriceUsdMilli: 300n, label: 'Desde 250 envíos por mes' },
  { minShipments: 500, unitPriceUsdMilli: 250n, label: 'Desde 500 envíos por mes' },
  { minShipments: 1000, unitPriceUsdMilli: 180n, label: 'Desde 1000 envíos por mes' },
  { minShipments: 2500, unitPriceUsdMilli: 140n, label: 'Desde 2500 envíos por mes' },
  { minShipments: 5000, unitPriceUsdMilli: 110n, label: 'Desde 5000 envíos por mes' },
]);

/**
 * Precios por envío en UYU que regían antes de D35, por corte de tramo.
 * No se usan para cobrar: existen para poder DEMOSTRAR, con un test, cuánto
 * paga de más o de menos un cliente actual a un tipo de cambio dado.
 */
export const LEGACY_UNIT_PRICE_UYU: ReadonlyMap<number, number> = new Map([
  [0, 20],
  [50, 17],
  [100, 15],
  [250, 12],
  [500, 10],
  [1000, 7],
]);

/**
 * Tipo de cambio BASE, en milésimos de UYU por dólar: 40,000 = 40 UYU/USD.
 *
 * NO es la cotización del día ni pretende serlo: es el número del que salió
 * la escalera de D35 (0,50 × 40 = 20; 0,30 × 40 = 12; 0,25 × 40 = 10, los tres
 * exactos contra el precio viejo). Se usa como default cuando `USD_UYU_RATE`
 * no está seteada y como tipo fijo del ledger del worker, que no puede
 * moverse con una env var sin reescribir períodos ya liquidados.
 *
 * 🔴 Para que NINGÚN precio viejo suba hace falta un tipo ≤ 38,88 (ver
 * `maxRateWithoutIncreaseMilli()`). A 40 sube sólo el escalón de 1.000.
 */
export const BASE_USD_UYU_RATE_MILLI = 40_000n;

/** Nombre de la variable de entorno que manda sobre el tipo de cambio. */
export const USD_UYU_RATE_ENV = 'USD_UYU_RATE';

let warnedInvalidRate = false;

/**
 * Tipo de cambio vigente en milésimos de UYU por dólar.
 *
 * `USD_UYU_RATE` se escribe en pesos con hasta tres decimales ("41", "41.5",
 * "38.875"). Se parsea a mano, sin `parseFloat`: el valor entra directo a un
 * cobro y un `41.30000000000001` no tiene por qué existir. Valor ausente,
 * ilegible o fuera de un rango plausible (1–1000) → default + un aviso una
 * sola vez, nunca una excepción: quedarse sin checkout por una env mal
 * tipeada es peor que cobrar al tipo base.
 */
export function getUsdUyuRateMilli(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env[USD_UYU_RATE_ENV];
  if (raw === undefined || raw.trim() === '') return BASE_USD_UYU_RATE_MILLI;
  const parsed = parseRateMilli(raw);
  if (parsed === null) {
    if (!warnedInvalidRate) {
      warnedInvalidRate = true;
      console.error(
        `[pricing] ${USD_UYU_RATE_ENV}="${raw}" no es un número de 1 a 1000 con hasta 3 ` +
          `decimales — se cobra al tipo base ${formatRate(BASE_USD_UYU_RATE_MILLI)} UYU/USD`,
      );
    }
    return BASE_USD_UYU_RATE_MILLI;
  }
  return parsed;
}

/** Parser puro del texto de la env. `null` si no sirve. Exportado para tests. */
export function parseRateMilli(raw: string): bigint | null {
  const m = /^\s*(\d{1,4})(?:[.,](\d{1,3}))?\s*$/.exec(raw);
  if (!m) return null;
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? '').padEnd(3, '0'));
  const milli = whole * 1000n + frac;
  if (milli < 1000n || milli > 1_000_000n) return null; // 1 a 1000 UYU/USD
  return milli;
}

/** Sólo para tests: permite volver a emitir el aviso de tipo de cambio inválido. */
export function _resetPricingWarnings(): void {
  warnedInvalidRate = false;
}

/**
 * División entera con redondeo al más cercano, mitad para arriba.
 * Todos los montos son positivos; no se contempla el caso negativo a propósito.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('divRoundHalfUp: denominador no positivo');
  if (numerator < 0n) throw new RangeError('divRoundHalfUp: numerador negativo');
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Milésimos de USD → milésimos de UYU al tipo dado. Redondeo half-up. */
export function usdMilliToUyuMilli(usdMilli: bigint, rateMilli: bigint): bigint {
  assertRate(rateMilli);
  return divRoundHalfUp(usdMilli * rateMilli, 1000n);
}

/**
 * Milésimos de USD → PESOS ENTEROS. Es el monto que se le manda a MercadoPago
 * y el que se guarda en `CreditPurchase.totalPriceUyu`: nada de 1479,9999.
 */
export function usdMilliToUyuWhole(usdMilli: bigint, rateMilli: bigint): number {
  assertRate(rateMilli);
  return Number(divRoundHalfUp(usdMilli * rateMilli, 1_000_000n));
}

/** Valida el invariante estructural de la escalera. Corre al importar. */
export function assertPricingTiersValid(tiers: readonly PricingTier[] = PRICING_TIERS): void {
  if (tiers.length === 0) throw new Error('La escalera no puede estar vacía');
  if (tiers[0].minShipments !== 0) {
    throw new Error('El primer escalón debe arrancar en 0 para cubrir todo volumen');
  }
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].minShipments <= tiers[i - 1].minShipments) {
      throw new Error(
        `Escalones desordenados: ${tiers[i - 1].minShipments} → ${tiers[i].minShipments}`,
      );
    }
    if (tiers[i].unitPriceUsdMilli >= tiers[i - 1].unitPriceUsdMilli) {
      throw new Error(
        `El escalón ${tiers[i].minShipments} no es más barato que el anterior; ` +
          'un tarifario por volumen que sube de precio no tiene sentido',
      );
    }
  }
  for (const t of tiers) {
    if (t.unitPriceUsdMilli <= 0n) {
      throw new Error(`Precio no positivo en el escalón ${t.minShipments}`);
    }
  }
}
assertPricingTiersValid();

/** El escalón que aplica a un volumen mensual dado. */
export function tierFor(n: number, tiers: readonly PricingTier[] = PRICING_TIERS): PricingTier {
  assertCount(n);
  let tier = tiers[0];
  for (const t of tiers) {
    if (n >= t.minShipments) tier = t;
    else break;
  }
  return tier;
}

/** Precio de lista por envío (milésimos de USD) para un volumen mensual dado. */
export function unitPriceUsdMilliFor(
  n: number,
  tiers: readonly PricingTier[] = PRICING_TIERS,
): bigint {
  return tierFor(n, tiers).unitPriceUsdMilli;
}

/**
 * Lo que cuesta el mes entero con `n` envíos, en milésimos de USD.
 *
 * NO es `n × precio(n)`: es el mínimo entre eso y lo que costaría el mes si el
 * cliente hubiera llegado al piso de cualquier escalón mejor.
 *
 *     total(n) = min sobre todos los escalones t de:  max(n, t.minShipments) × t.unitPrice
 *
 * Es exactamente `periodTotalMilli` de `apps/worker/src/billing/tiers.ts`, con
 * la unidad cambiada. Sin el mínimo, la escalera de D35 tendría siete zonas
 * muertas donde hacer MÁS envíos sale MENOS plata (p. ej. 3.929 envíos a 0,14
 * = USD 550,06, más que 5.000 envíos a 0,11 = USD 550,00). Con el mínimo el
 * total es monótono no decreciente y nunca supera el techo del escalón
 * siguiente.
 */
export function periodTotalUsdMilli(
  n: number,
  tiers: readonly PricingTier[] = PRICING_TIERS,
): bigint {
  assertCount(n);
  if (n === 0) return 0n;
  let best: bigint | null = null;
  for (const t of tiers) {
    const billableCount = BigInt(Math.max(n, t.minShipments));
    const candidate = billableCount * t.unitPriceUsdMilli;
    if (best === null || candidate < best) best = candidate;
  }
  return best as bigint;
}

/**
 * Precio efectivo por envío que termina pagando el cliente. Es lo que va en el
 * recibo y en la UI: con 800 envíos el precio de lista dice 0,25 pero el
 * efectivo es 180,00/800 = 0,225, porque se cobra el techo del escalón de 1000.
 * Trunca hacia abajo (división entera): nunca muestra un precio mayor al real.
 */
export function effectiveUnitUsdMilli(
  n: number,
  tiers: readonly PricingTier[] = PRICING_TIERS,
): bigint {
  assertCount(n);
  if (n === 0) return 0n;
  return periodTotalUsdMilli(n, tiers) / BigInt(n);
}

export interface NextTierHint {
  /** El escalón al que se llega. */
  readonly tier: PricingTier;
  /** Cuántos envíos más hacen falta para tocarlo. Siempre ≥ 1. */
  readonly shipmentsMore: number;
  /**
   * Cuánto baja el precio por envío REALMENTE PAGADO, en milésimos de USD.
   *
   * Es efectivo contra efectivo, no lista contra lista, y por eso puede ser 0:
   * quien hace 4.999 envíos ya paga el techo del escalón de 5.000 (0,110
   * efectivo) y llegar a 5.000 no le cambia nada. El número de lista diría
   * "ahorrás 0,03" y sería mentira. Cuando esto da 0, la UI muestra que el
   * cliente ya está en el mejor precio en vez de un empujón vacío.
   */
  readonly savesPerShipmentUsdMilli: bigint;
  /** La misma diferencia pero entre precios de LISTA. Siempre > 0. Para copy comparativo. */
  readonly listSavesPerShipmentUsdMilli: bigint;
  /** Total del mes al llegar al escalón, en milésimos de USD. */
  readonly totalAtTierUsdMilli: bigint;
}

/**
 * El empujón de la UI: "con N envíos más pagás X menos por envío".
 * `null` cuando el cliente ya está en el último escalón.
 *
 * Bordes: en 49 devuelve 1 envío más; en 50 salta al escalón de 100 (50 más).
 * Que en el piso del escalón ya apunte al siguiente es a propósito: el cartel
 * nunca dice "te falta 0".
 */
export function nextTierHint(
  n: number,
  tiers: readonly PricingTier[] = PRICING_TIERS,
): NextTierHint | null {
  assertCount(n);
  const next = tiers.find((t) => t.minShipments > n);
  if (!next) return null;
  return {
    tier: next,
    shipmentsMore: next.minShipments - n,
    savesPerShipmentUsdMilli:
      // Con 0 envíos no hay precio efectivo: se compara contra el de lista,
      // que es lo que pagaría el primer envío. Sin esto el ahorro daría negativo.
      (n === 0 ? unitPriceUsdMilliFor(0, tiers) : effectiveUnitUsdMilli(n, tiers)) -
      effectiveUnitUsdMilli(next.minShipments, tiers),
    listSavesPerShipmentUsdMilli: unitPriceUsdMilliFor(n, tiers) - next.unitPriceUsdMilli,
    totalAtTierUsdMilli: periodTotalUsdMilli(next.minShipments, tiers),
  };
}

export interface UsdQuote {
  readonly shipments: number;
  readonly totalUsdMilli: bigint;
  readonly effectiveUnitUsdMilli: bigint;
  readonly listUnitUsdMilli: bigint;
  readonly tier: PricingTier;
  /** true si el cliente está pagando el techo de un escalón mejor que el suyo. */
  readonly cappedByBetterTier: boolean;
  readonly next: NextTierHint | null;
}

/** Todo lo que el simulador de precios necesita, en dólares. */
export function quoteUsd(n: number, tiers: readonly PricingTier[] = PRICING_TIERS): UsdQuote {
  assertCount(n);
  const totalUsdMilli = periodTotalUsdMilli(n, tiers);
  const listUnitUsdMilli = unitPriceUsdMilliFor(n, tiers);
  return {
    shipments: n,
    totalUsdMilli,
    effectiveUnitUsdMilli: effectiveUnitUsdMilli(n, tiers),
    listUnitUsdMilli,
    tier: tierFor(n, tiers),
    cappedByBetterTier: totalUsdMilli < BigInt(n) * listUnitUsdMilli,
    next: nextTierHint(n, tiers),
  };
}

// ---------------------------------------------------------------------------
// Guardarraíl contra la promesa de D35: "ningún cliente actual paga más"
// ---------------------------------------------------------------------------

export interface LegacyRegression {
  readonly minShipments: number;
  readonly legacyUyu: number;
  /** Precio nuevo por envío en milésimos de UYU al tipo evaluado. */
  readonly newUyuMilli: bigint;
}

/**
 * Escalones cuyo precio en pesos SUBE respecto del tarifario viejo, al tipo de
 * cambio dado. Lista vacía = la promesa de D35 se cumple sin asterisco.
 *
 * A tipo 40 devuelve exactamente un elemento (el de 1.000 envíos). A cualquier
 * tipo por encima de `maxRateWithoutIncreaseMilli()` devuelve más.
 */
export function legacyPriceRegressions(
  rateMilli: bigint,
  tiers: readonly PricingTier[] = PRICING_TIERS,
): LegacyRegression[] {
  assertRate(rateMilli);
  const out: LegacyRegression[] = [];
  for (const t of tiers) {
    const legacyUyu = LEGACY_UNIT_PRICE_UYU.get(t.minShipments);
    if (legacyUyu === undefined) continue; // escalón nuevo: no tiene con qué comparar
    const newUyuMilli = usdMilliToUyuMilli(t.unitPriceUsdMilli, rateMilli);
    if (newUyuMilli > BigInt(legacyUyu) * UYU_MILLI) {
      out.push({ minShipments: t.minShipments, legacyUyu, newUyuMilli });
    }
  }
  return out;
}

/**
 * El tipo de cambio más alto al que ningún precio viejo sube, en milésimos.
 * Con la escalera de D35 da 38.888 (38,888 UYU/USD), fijado por el escalón de
 * 1.000: 7 UYU / 0,18 USD. Por encima de eso, `legacyPriceRegressions()` deja
 * de estar vacía.
 */
export function maxRateWithoutIncreaseMilli(
  tiers: readonly PricingTier[] = PRICING_TIERS,
): bigint {
  let best: bigint | null = null;
  for (const t of tiers) {
    const legacyUyu = LEGACY_UNIT_PRICE_UYU.get(t.minShipments);
    if (legacyUyu === undefined) continue;
    // rate ≤ legacyUyuMilli * 1000 / unitPriceUsdMilli, truncado hacia abajo.
    const cap = (BigInt(legacyUyu) * UYU_MILLI * 1000n) / t.unitPriceUsdMilli;
    if (best === null || cap < best) best = cap;
  }
  if (best === null) throw new Error('No hay escalones con precio viejo con qué comparar');
  return best;
}

// ---------------------------------------------------------------------------
// Formato — para UI y logs. Nunca para calcular.
// ---------------------------------------------------------------------------

/** `500n` → `"0,50"`. Dos decimales, coma, sin símbolo. */
export function formatUsdMilli(usdMilli: bigint): string {
  const cents = divRoundHalfUp(usdMilli, 10n);
  const whole = cents / 100n;
  const rest = cents % 100n;
  return `${whole.toLocaleString('es-UY')},${rest.toString().padStart(2, '0')}`;
}

/** `40000n` → `"40"`, `38875n` → `"38,875"`. Sin ceros decorativos. */
export function formatRate(rateMilli: bigint): string {
  const whole = rateMilli / 1000n;
  const frac = (rateMilli % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole},${frac}` : `${whole}`;
}

function assertRate(rateMilli: bigint): void {
  if (rateMilli < 1000n || rateMilli > 1_000_000n) {
    throw new RangeError(`Tipo de cambio implausible: ${rateMilli} milésimos de UYU por USD`);
  }
}

function assertCount(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`El volumen de envíos debe ser un entero >= 0, recibió ${n}`);
  }
  if (n > 10_000_000) {
    throw new RangeError(`Volumen implausible (${n}); probable bug de llamador`);
  }
}
