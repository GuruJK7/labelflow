/**
 * Liquidación del período — núcleo puro, sin DB ni I/O.
 *
 * EL PROBLEMA QUE RESUELVE
 * ------------------------
 * Con descuento por volumen, el precio de un envío depende de cuántos envíos
 * termine haciendo el cliente ese mes — dato que no se conoce cuando el envío
 * ocurre. El diseño ingenuo cobra el precio de lista del momento y después
 * acredita "rebates" al cruzar cada tramo. Ese diseño tiene un agujero:
 * un reintegro devuelve el precio BRUTO cobrado, no el NETO que el cliente
 * terminó pagando, y la diferencia es saldo creado de la nada.
 *
 *   Ejemplo real del tarifario vigente: 1.000 envíos generan débitos brutos
 *   por 12.087 UYU y rebates por 5.087, neto 7.000. Si después se reintegran
 *   los 1.000 al precio bruto, el cliente termina con 12.087 de saldo habiendo
 *   depositado 7.000. Son 5.087 UYU de aire, gastables en AutoBoost, que paga
 *   a su proveedor en dólares reales.
 *
 * LA SOLUCIÓN
 * -----------
 * No se lleva la cuenta de rebates. En cada evento del período (un envío nuevo,
 * un reintegro) se recalcula el total que el mes DEBE valer y se emite un solo
 * asiento con la diferencia contra lo ya registrado:
 *
 *     objetivo = -periodTotalMilli(n_facturables)
 *     delta    = objetivo - neto_actual
 *
 * El invariante sale por construcción, no por prolijidad contable:
 *
 *     para todo (wallet, período):  suma de deltas del período == -total(n)
 *
 * Y es AUTO-REPARABLE: si por lo que sea un asiento anterior quedó mal o se
 * perdió, la siguiente liquidación lo corrige sola. No hace falta que ninguna
 * secuencia de eventos sea perfecta; sólo que el estado se lea bien.
 */

import { periodTotalMilli, effectiveUnitPriceMilli, type Tier, TIERS } from './tiers';

/** Motivos de asiento que participan del cálculo del período. */
export const PERIOD_REASONS = ['shipment', 'settlement'] as const;
export type PeriodReason = (typeof PERIOD_REASONS)[number];

export interface PeriodState {
  /**
   * Envíos facturables del período DESPUÉS de aplicar el evento actual.
   * Facturable = tiene guía real emitida y no fue reintegrado.
   * Un reintento NO suma: no genera guía nueva.
   */
  readonly billableShipments: number;
  /**
   * Suma de todos los deltas ya registrados para este wallet y período,
   * considerando únicamente los motivos de PERIOD_REASONS.
   * Es negativa o cero (son cargos).
   */
  readonly recordedNetMilli: bigint;
}

export interface Settlement {
  /** Delta a asentar. 0n significa que no hay nada que hacer: no emitir asiento. */
  readonly deltaMilli: bigint;
  /** Lo que debe valer el período completo, en positivo. Para recibos y UI. */
  readonly periodTotalMilli: bigint;
  /** Precio efectivo por envío del período. Para recibos y UI. */
  readonly effectiveUnitMilli: bigint;
  readonly billableShipments: number;
}

/**
 * Calcula el asiento de liquidación de un período.
 *
 * Es una función pura: mismas entradas, misma salida, sin efectos. Toda la
 * dificultad del cobro por volumen vive acá adentro y se puede testear sin
 * base de datos.
 */
export function computeSettlement(
  state: PeriodState,
  tiers: readonly Tier[] = TIERS,
): Settlement {
  const { billableShipments, recordedNetMilli } = state;

  if (!Number.isInteger(billableShipments) || billableShipments < 0) {
    throw new RangeError(
      `billableShipments debe ser un entero >= 0, recibió ${billableShipments}`,
    );
  }
  if (recordedNetMilli > 0n) {
    // Un período de envíos no puede tener neto positivo: serían cargos que
    // dejaron plata. Si pasa, hay un asiento con el motivo equivocado y
    // liquidar encima taparía el problema en vez de mostrarlo.
    throw new Error(
      `Neto del período positivo (${recordedNetMilli}); hay asientos mal clasificados. ` +
        'No se liquida hasta resolverlo a mano.',
    );
  }

  const total = periodTotalMilli(billableShipments, tiers);
  const target = -total;

  return {
    deltaMilli: target - recordedNetMilli,
    periodTotalMilli: total,
    effectiveUnitMilli: effectiveUnitPriceMilli(billableShipments, tiers),
    billableShipments,
  };
}

/**
 * Verifica el invariante del período. Se usa en tests y en el reconciliador
 * diario; si esto falla en producción, el ledger está corrupto y hay que
 * frenar el cobro, no seguir.
 */
export function assertPeriodInvariant(
  billableShipments: number,
  netMilli: bigint,
  tiers: readonly Tier[] = TIERS,
): void {
  const expected = -periodTotalMilli(billableShipments, tiers);
  if (netMilli !== expected) {
    throw new Error(
      `Invariante de período roto: con ${billableShipments} envíos el neto debe ser ` +
        `${expected} y es ${netMilli} (diferencia ${netMilli - expected})`,
    );
  }
}

/**
 * Clave de idempotencia de un envío. La guía DAC es el hecho físico facturable:
 * existe o no existe, y es única por cuenta DAC.
 *
 * VA EL tenantId ADENTRO A PROPÓSITO. Cada cliente usa SU PROPIA cuenta DAC y
 * DAC numera las guías por cuenta, así que dos clientes distintos pueden recibir
 * el mismo número. Sin el tenantId, el segundo cliente choca contra la clave del
 * primero y su envío sale gratis, en silencio y sin error.
 */
export function shipmentIdemKey(tenantId: string, dacGuia: string): string {
  const guia = dacGuia.trim();
  if (!tenantId) throw new Error('shipmentIdemKey: falta tenantId');
  if (!guia) throw new Error('shipmentIdemKey: falta la guía');
  if (guia.startsWith('PENDING-') || guia.startsWith('TEST-')) {
    throw new Error(
      `shipmentIdemKey: "${guia}" no es una guía real; no se factura un placeholder`,
    );
  }
  return `ship:v1:${tenantId}:${guia}`;
}

/** Clave del asiento de liquidación. `seq` es el número de liquidaciones previas. */
export function settlementIdemKey(walletId: string, periodYm: string, seq: number): string {
  if (!/^\d{4}-\d{2}$/.test(periodYm)) {
    throw new Error(`Período inválido: "${periodYm}", se espera YYYY-MM`);
  }
  return `settle:v1:${walletId}:${periodYm}:${seq}`;
}

/**
 * Período contable de una fecha, en la zona horaria del negocio.
 * Uruguay no tiene horario de verano desde 2015, así que un offset fijo de
 * -3 es correcto y evita arrastrar una dependencia de zonas horarias al
 * núcleo de facturación.
 */
export const UY_UTC_OFFSET_HOURS = -3;

export function periodOf(date: Date): string {
  const shifted = new Date(date.getTime() + UY_UTC_OFFSET_HOURS * 3600 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
