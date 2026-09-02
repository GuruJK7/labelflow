import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_USD_UYU_RATE_MILLI, periodTotalMilli } from '../billing/tiers';

/**
 * 🔴 ALAMBRE DE TROPIEZO: el día que el monedero acepte DEPÓSITOS, hay que
 * resolver los dos tipos de cambio antes de escribir la primera línea.
 *
 * EL PROBLEMA (revisión 2026-09-02). Hay dos tipos de cambio en el mismo
 * producto: el checkout convierte a pesos con `USD_UYU_RATE` (env, movible) y
 * el ledger tarifa con `BASE_USD_UYU_RATE_MILLI` (40, fijo a propósito).
 *
 * HOY NO HAY FUGA y esto no es un bug: el saldo vivo se cuenta en ENVÍOS
 * (`Tenant.shipmentCredits`, 1:1) y el ledger en pesos está en sombra, sin
 * ningún camino de depósito — lo único que mueve `balanceMilli` es la
 * liquidación. Pero el docblock de `tiers.ts` declara el modelo destino
 * ("el monedero se denomina en PLATA... Comprar = depositar plata"), y PR #4
 * es el que lo va a cablear.
 *
 * SIMULADO, conectando el depósito (los números están abajo como test):
 *   tipo 44 → pack_5000 deposita 24.200 UYU y compra 5.500 envíos (+10 %)
 *   tipo 36 → pack_5000 deposita 19.800 UYU y compra 3.535 envíos (-29,3 %)
 *   tipo 36 → pack_1000 deposita  6.480 UYU y compra   648 envíos (-35,2 %)
 * El -29,3 % es MUCHO peor que el -10 % que sugeriría la razón 36/40: el
 * depósito cae justo debajo del techo de la meseta 3.930-5.000 y se cuelga ahí.
 * Cobrarle a alguien 5.000 envíos y darle 3.535 no es un redondeo.
 *
 * QUÉ HAY QUE HACER cuando se cablee el depósito (una de las dos):
 *   a) el asiento del depósito guarda el tipo con el que se convirtió ESA
 *      compra, y el saldo se consume contra ese tipo; o
 *   b) el ledger se denomina en milésimos de USD y sólo convierte al mostrar.
 * Lo que NO se puede hacer es que el worker lea `USD_UYU_RATE`: una env movible
 * reescribiría períodos ya liquidados y reventaría `assertPeriodInvariant`.
 *
 * Este test falla en cuanto aparezca un camino de depósito. No es para
 * bloquear: es para que quien lo escriba lea esto antes.
 */
const LEDGER = readFileSync(join(__dirname, '..', 'billing', 'ledger.ts'), 'utf8');

describe('alambre de tropiezo: depósitos y el segundo tipo de cambio', () => {
  it('hoy lo ÚNICO que mueve balanceMilli es la liquidación', () => {
    // Sólo las LLAMADAS, no la firma del cliente inyectado.
    const mutaciones = LEDGER.match(/tx\.wallet\.update\(/g) ?? [];
    expect(
      mutaciones.length,
      'apareció otro camino que mueve el saldo del wallet. Si es un DEPÓSITO, leé el ' +
        'docblock de este test ANTES de seguir: hay dos tipos de cambio (USD_UYU_RATE en el ' +
        'checkout, 40 fijo en el ledger) y conectarlos sin guardar el tipo de la compra ' +
        'le da al cliente hasta 29 % menos envíos de los que pagó.',
    ).toBe(1);
  });

  it('hoy no existe un asiento de tipo depósito', () => {
    const razones = new Set([...LEDGER.matchAll(/reason:\s*'([a-z_]+)'/g)].map((m) => m[1]));
    // Las tres razones de asiento que existen (las otras que matchea el regex
    // son razones de RESULTADO, no de asiento: not_billable, no_shipment).
    for (const esperada of ['shipment', 'refund', 'settlement']) {
      expect(razones.has(esperada), esperada).toBe(true);
    }
    const deposito = [...razones].filter((r) =>
      /dep[oó]sito|deposit|topup|top_up|recarga|purchase|compra/.test(r),
    );
    expect(
      deposito,
      'apareció un asiento de depósito. Leé el docblock de este test ANTES de seguir: ' +
        'el asiento tiene que guardar el tipo de cambio con el que se convirtió esa compra, ' +
        'o el ledger tiene que denominarse en USD y convertir sólo al mostrar.',
    ).toEqual([]);
  });

  it('MEDIDO: cuánto se rompe si el depósito se cablea sin guardar el tipo', () => {
    // Cuántos envíos compra un depósito de `uyuMilli` contra la escalera fija.
    const enviosQueCompra = (uyuMilli: bigint): number => {
      let n = 0;
      while (periodTotalMilli(n + 1) <= uyuMilli && n < 20_000) n++;
      return n;
    };
    // Lo que deposita un pack, en milésimos de UYU, al tipo del checkout.
    const deposito = (packUsdMilli: bigint, rateMilli: bigint) =>
      (packUsdMilli * rateMilli) / 1000n;

    // Al tipo base los dos lados coinciden: es el único punto sin fuga.
    expect(enviosQueCompra(deposito(550_000n, BASE_USD_UYU_RATE_MILLI))).toBe(5000);
    expect(enviosQueCompra(deposito(175_000n, BASE_USD_UYU_RATE_MILLI))).toBe(1000);

    // Tipo 44: el cliente paga 5.000 y se lleva 5.500. Pierde la empresa.
    expect(enviosQueCompra(deposito(550_000n, 44_000n))).toBe(5500);
    expect(enviosQueCompra(deposito(175_000n, 44_000n))).toBe(1100);

    // Tipo 36: el cliente paga 5.000 y se lleva 3.535 (-29,3 %). Pierde él.
    expect(enviosQueCompra(deposito(550_000n, 36_000n))).toBe(3535);
    // Y el pack chico es todavía peor: -37,0 %.
    expect(enviosQueCompra(deposito(175_000n, 36_000n))).toBe(630);
  });
});
