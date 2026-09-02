/**
 * Tarifario por volumen — núcleo puro, sin DB ni I/O.
 *
 * DENOMINACIÓN (D35): el precio de lista está en DÓLARES por envío según el
 * volumen mensual; los pesos del ledger se derivan de ahí al tipo de cambio
 * base fijo de este módulo.
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

/**
 * Tipo de cambio BASE, en milésimos de UYU por dólar (40.000 = 40 UYU/USD).
 *
 * ES FIJO A PROPÓSITO Y NO LEE NINGUNA ENV. El ledger está denominado en pesos
 * (D1) y `assertPeriodInvariant` compara asientos ya escritos contra lo que
 * `periodTotalMilli` dice hoy: si el tipo de cambio se moviera con una env var,
 * cambiar esa var reescribiría el valor de períodos ya liquidados y el
 * invariante explotaría en producción sin que nadie haya tocado un envío.
 * `USD_UYU_RATE` mueve sólo lo que se COBRA en el checkout de MercadoPago
 * (`apps/web/lib/pricing.ts`); acá se convierte al base y punto.
 *
 * 🔴 LA OTRA MITAD NO ESTÁ RESUELTA. Que el worker no lea la env es correcto,
 * pero deja DOS tipos de cambio en el mismo producto. Hoy no hay fuga: el saldo
 * vivo se cuenta en ENVÍOS (`Tenant.shipmentCredits`, 1:1) y este ledger está
 * en sombra sin ningún camino de depósito. El día que se cablee el depósito
 * —el modelo destino que declara el docblock de arriba— un pack comprado a un
 * tipo distinto de 40 compra una cantidad de envíos distinta de la que se
 * vendió: a 36, `pack_5000` deposita 19.800 y compra 3.535 envíos (-29,3 %),
 * porque el depósito queda justo debajo del techo de la meseta 3.930-5.000.
 * Antes de escribir ese depósito hay que elegir: el asiento guarda el tipo de
 * SU compra, o el ledger se denomina en USD y convierte sólo al mostrar.
 * Medido y con alambre de tropiezo en
 * `src/__tests__/billing-fx-deposit-tripwire.test.ts`.
 */
export const BASE_USD_UYU_RATE_MILLI = 40_000n;

/** División entera con redondeo al más cercano, mitad para arriba. Sólo positivos. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Milésimos de USD → milésimos de UYU al tipo base. */
export function usdMilliToUyuMilliAtBase(usdMilli: bigint): bigint {
  return divRoundHalfUp(usdMilli * BASE_USD_UYU_RATE_MILLI, 1000n);
}

export interface Tier {
  /** Volumen mensual a partir del cual aplica este precio. */
  readonly minShipments: number;
  /**
   * Precio por envío en milésimos de USD. ES EL PRECIO AUTORITATIVO (D35):
   * `unitPriceMilli` se deriva de acá, nunca al revés.
   */
  readonly unitPriceUsdMilli: bigint;
  /** Precio por envío, en milésimos de UYU, al tipo base. Derivado. */
  readonly unitPriceMilli: bigint;
  /** Etiqueta para UI y recibos. */
  readonly label: string;
}

function tier(minShipments: number, unitPriceUsdMilli: bigint, label: string): Tier {
  return {
    minShipments,
    unitPriceUsdMilli,
    unitPriceMilli: usdMilliToUyuMilliAtBase(unitPriceUsdMilli),
    label,
  };
}

/**
 * Tarifario vigente — LA MISMA ESCALERA que `apps/web/lib/pricing.ts` (D35),
 * en dólares por envío según el volumen mensual:
 *
 *     0 → 0,50 · 50 → 0,42 · 100 → 0,37 · 250 → 0,30
 *     500 → 0,25 · 1000 → 0,18 · 2500 → 0,14 · 5000 → 0,11
 *
 * Está duplicada, no importada: `apps/worker` compila a CommonJS con
 * `rootDir: "./src"` y no puede importar fuera de su árbol. El test
 * `apps/web/lib/__tests__/pricing-worker-sync.test.ts` compara las dos tablas
 * escalón por escalón y falla si alguien mueve una sola.
 *
 * Los seis primeros escalones son los precios que ya regían en pesos
 * (20/17/15/12/10/7) al tipo base; el de 1.000 queda en 7,20 en vez de 7,00
 * (0,18 × 40) — la única suba, documentada en D35 y medida por
 * `legacyPriceRegressions()` del lado web.
 *
 * Debe quedar ordenado por minShipments ascendente. `assertTiersValid()` lo
 * verifica y corre al importar el módulo.
 */
export const TIERS: readonly Tier[] = Object.freeze([
  tier(0, 500n, 'Hasta 49 envíos/mes'),
  tier(50, 420n, 'Desde 50 envíos/mes'),
  tier(100, 370n, 'Desde 100 envíos/mes'),
  tier(250, 300n, 'Desde 250 envíos/mes'),
  tier(500, 250n, 'Desde 500 envíos/mes'),
  tier(1000, 180n, 'Desde 1000 envíos/mes'),
  tier(2500, 140n, 'Desde 2500 envíos/mes'),
  tier(5000, 110n, 'Desde 5000 envíos/mes'),
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
    if (tiers[i].unitPriceUsdMilli >= tiers[i - 1].unitPriceUsdMilli) {
      throw new Error(
        `El tramo ${tiers[i].minShipments} no es más barato que el anterior; ` +
          'un tarifario por volumen que sube de precio no tiene sentido',
      );
    }
    if (tiers[i].unitPriceMilli >= tiers[i - 1].unitPriceMilli) {
      throw new Error(
        `El tramo ${tiers[i].minShipments} no es más barato que el anterior en pesos; ` +
          'el redondeo del tipo de cambio empató dos escalones',
      );
    }
  }
  for (const t of tiers) {
    if (t.unitPriceMilli <= 0n) throw new Error(`Precio no positivo en el tramo ${t.minShipments}`);
    if (t.unitPriceUsdMilli <= 0n) {
      throw new Error(`Precio en USD no positivo en el tramo ${t.minShipments}`);
    }
    if (t.unitPriceMilli !== usdMilliToUyuMilliAtBase(t.unitPriceUsdMilli)) {
      throw new Error(
        `El tramo ${t.minShipments} tiene el precio en pesos desenganchado del de USD; ` +
          'los pesos se DERIVAN del dólar al tipo base, no se escriben a mano',
      );
    }
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
 * POR QUÉ. Con `n × precio(n)` a secas, la escalera de D35 tiene SIETE ZONAS
 * MUERTAS donde hacer MÁS envíos sale MENOS plata en términos absolutos
 * (en USD, que es donde está denominado el precio):
 *
 *     43..49     pagan más que 50     (43×0,50 = 21,50   >   50×0,42 = 21,00)
 *     89..99     pagan más que 100    (89×0,42 = 37,38   >  100×0,37 = 37,00)
 *     203..249   pagan más que 250    (203×0,37 = 75,11  >  250×0,30 = 75,00)
 *     417..499   pagan más que 500    (417×0,30 = 125,10 >  500×0,25 = 125,00)
 *     721..999   pagan más que 1000   (721×0,25 = 180,25 > 1000×0,18 = 180,00)
 *     1945..2499 pagan más que 2500   (1945×0,18 = 350,10 > 2500×0,14 = 350,00)
 *     3929..4999 pagan más que 5000   (3929×0,14 = 550,06 > 5000×0,11 = 550,00)
 *
 * Un cliente con 800 envíos pagaría USD 200 mientras uno con 1.000 paga 180.
 * Eso no es un tarifario, es una trampa: castiga al que está a punto de crecer,
 * y el primero que lo note tiene razón en enojarse.
 *
 * Con el mínimo, `total` queda monótona no decreciente: hacer un envío más
 * nunca puede bajar la factura, y nunca se cobra más que el techo del tramo
 * siguiente. `__tests__/billing-tiers.test.ts` lo verifica exhaustivamente
 * de 0 a 6000.
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
