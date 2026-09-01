/**
 * Reglas de fondos del monedero unificado — núcleo puro, sin DB ni I/O.
 *
 * Un solo saldo, en milésimos de UYU, que sirve para envíos (AutoEnvía) y
 * para servicios de redes (AutoBoost). Como el saldo ES plata, gastar el
 * sobrante de envíos en bots no requiere ninguna tasa de conversión — y por
 * lo tanto no hay nada que arbitrar. Eso es todo el truco.
 *
 * PERO hay una asimetría real entre los dos productos que sí hay que modelar:
 *
 *   - Un envío le cuesta a LabelFlow casi nada al margen (el flete lo paga el
 *     cliente en SU cuenta DAC). Regalar envíos cuesta infraestructura.
 *   - Un pedido de AutoBoost le cuesta a LabelFlow DÓLARES REALES: se le paga
 *     al proveedor mayorista por cada pedido.
 *
 * Por eso el saldo que NO entró como plata —bonos de bienvenida, envíos de
 * prueba, créditos de referido, ajustes— puede gastarse en envíos pero NO en
 * AutoBoost. Si no, regalar un bono se convierte en regalar dólares.
 */

/** Origen del saldo. Determina en qué se puede gastar. */
export type FundingSource =
  /** Plata que entró de verdad por MercadoPago (u otra pasarela). */
  | 'cash'
  /** Bono de bienvenida, envíos de prueba, referidos, ajustes de admin. */
  | 'granted';

export interface WalletFunds {
  /** Saldo total disponible, en milésimos de UYU. Puede ser negativo. */
  readonly balanceMilli: bigint;
  /**
   * Acumulado histórico de plata realmente ingresada, neto de reembolsos y
   * contracargos. NUNCA es un contador que sólo sube: si no baja en el
   * contracargo, un depósito desconocido deja habilitado para siempre el
   * gasto en dólares. Puede quedar negativo tras un contracargo abusivo, y
   * está bien que quede negativo.
   */
  readonly paidInMilli: bigint;
  /** Acumulado histórico gastado en AutoBoost. Sólo sube. */
  readonly smmSpentMilli: bigint;
}

export interface SpendRequest {
  readonly amountMilli: bigint;
  readonly product: 'shipping' | 'smm';
}

export type SpendDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: SpendDenialReason; readonly message: string };

export type SpendDenialReason =
  | 'invalid_amount'
  | 'insufficient_balance'
  | 'smm_requires_cash';

/**
 * ¿Se puede hacer este gasto?
 *
 * Nota deliberada sobre envíos: NO se bloquea por saldo. Cuando este chequeo
 * corre, DAC ya emitió la guía — el envío físico existe y es irreversible.
 * Negarse a cobrarlo no lo deshace, sólo pierde la plata. El saldo se frena
 * ANTES, en el planificador, decidiendo si se despacha o no. Acá se cobra y,
 * si hace falta, el saldo queda negativo y visible.
 */
export function canSpend(funds: WalletFunds, req: SpendRequest): SpendDecision {
  if (req.amountMilli <= 0n) {
    return {
      allowed: false,
      reason: 'invalid_amount',
      message: `Monto inválido: ${req.amountMilli}. Debe ser positivo.`,
    };
  }

  if (req.product === 'shipping') {
    // Ver nota de arriba: el envío ya ocurrió, siempre se asienta.
    return { allowed: true };
  }

  // AutoBoost: el gasto acumulado no puede superar la plata realmente ingresada.
  const wouldBeSpent = funds.smmSpentMilli + req.amountMilli;
  if (wouldBeSpent > funds.paidInMilli) {
    const disponible = funds.paidInMilli - funds.smmSpentMilli;
    return {
      allowed: false,
      reason: 'smm_requires_cash',
      message:
        'Los servicios de AutoBoost se pagan con saldo cargado, no con saldo de regalo. ' +
        `Disponible para AutoBoost: ${formatMilli(disponible > 0n ? disponible : 0n)}.`,
    };
  }

  if (req.amountMilli > funds.balanceMilli) {
    return {
      allowed: false,
      reason: 'insufficient_balance',
      message: `Saldo insuficiente: tenés ${formatMilli(funds.balanceMilli)} y hacen falta ${formatMilli(req.amountMilli)}.`,
    };
  }

  return { allowed: true };
}

/** Cuánto del saldo se puede gastar hoy en AutoBoost. Nunca negativo. */
export function smmSpendableMilli(funds: WalletFunds): bigint {
  const byCash = funds.paidInMilli - funds.smmSpentMilli;
  const cap = byCash < funds.balanceMilli ? byCash : funds.balanceMilli;
  return cap > 0n ? cap : 0n;
}

/**
 * Efecto de un movimiento de plata sobre `paidInMilli`.
 * Un depósito lo sube; reembolso y contracargo lo bajan por el mismo monto.
 * La simetría es el punto: sin ella, el contracargo deja crédito en dólares
 * habilitado para siempre.
 */
export function paidInDelta(
  kind: 'purchase' | 'refund' | 'chargeback' | 'grant',
  amountMilli: bigint,
): bigint {
  if (amountMilli < 0n) throw new RangeError('El monto de un movimiento no puede ser negativo');
  switch (kind) {
    case 'purchase':
      return amountMilli;
    case 'refund':
    case 'chargeback':
      return -amountMilli;
    case 'grant':
      return 0n; // el saldo de regalo no habilita gasto en dólares
    default: {
      const never: never = kind;
      throw new Error(`Movimiento desconocido: ${never}`);
    }
  }
}

/** Formatea milésimos como pesos para mensajes al usuario. */
export function formatMilli(milli: bigint): string {
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const pesos = abs / 1000n;
  const frac = abs % 1000n;
  const centavos = String(frac / 10n).padStart(2, '0');
  const entero = pesos.toLocaleString('es-UY');
  return `${neg ? '-' : ''}$${entero},${centavos}`;
}
