import { describe, it, expect } from 'vitest';
import {
  usdMilliToAmountString,
  needsRounding,
  isPaidStatus,
  isDeadStatus,
  APP_PURCHASE_ONE_TIME_CREATE,
} from '@/lib/shopify-billing';
import { PACK_SHIPMENTS, listPacks } from '@/lib/credit-packs';

/**
 * El catálogo COMPLETO, con los escalones grandes incluidos. `listPacks()` sin
 * opciones respeta `ENABLE_LARGE_CREDIT_PACKS` (apagado por defecto) y dejaría
 * 2.500 y 5.000 sin cubrir — que son justo los importes grandes, donde un
 * redondeo de un centavo se nota.
 */
const CATALOGO = listPacks(40_000n, { largePacks: true });
import { PRICING_TIERS, unitPriceUsdMilliFor } from '@/lib/pricing';

/**
 * El riel de cobro por Shopify (requisito 1.2 del App Store).
 *
 * Lo que puede salir caro acá es un solo tipo de error: que el monto que
 * Shopify cobra no sea el que la pantalla dice. La escalera vive en MILÉSIMOS
 * de dólar y Shopify cobra en CENTAVOS, así que cualquier escalón cuyo total
 * no caiga en un centavo exacto se cobraría redondeado sin que nadie se
 * entere. Estos tests recorren el catálogo entero.
 */
describe('monto que se le manda a Shopify', () => {
  it('convierte milésimos a los dos decimales de MoneyInput', () => {
    expect(usdMilliToAmountString(75_000)).toBe('75.00');
    expect(usdMilliToAmountString(175_000)).toBe('175.00');
    expect(usdMilliToAmountString(5_000)).toBe('5.00');
    expect(usdMilliToAmountString(0)).toBe('0.00');
  });

  it('rechaza montos imposibles en vez de mandar basura', () => {
    expect(() => usdMilliToAmountString(-1)).toThrow(RangeError);
    expect(() => usdMilliToAmountString(NaN)).toThrow(RangeError);
  });

  it('🔴 ningún pack del catálogo necesita redondeo', () => {
    // Si esto falla, hay un escalón cuyo total no cae en un centavo exacto y
    // el cobro dejaría de coincidir con lo publicado. No se arregla acá: se
    // arregla el precio, o se acepta el redondeo a sabiendas.
    const conResto = CATALOGO
      .filter((p) => needsRounding(p.totalPriceUsdMilli))
      .map((p) => `${p.id}=${p.totalPriceUsdMilli}`);
    expect(conResto).toEqual([]);
  });

  it('el importe cobrado es exactamente envíos × precio del escalón', () => {
    for (const n of PACK_SHIPMENTS) {
      const esperadoMilli = n * Number(unitPriceUsdMilliFor(n));
      const pack = CATALOGO.find((p) => p.shipments === n);
      expect(pack, `falta pack de ${n}`).toBeTruthy();
      expect(pack!.totalPriceUsdMilli).toBe(esperadoMilli);
      // Y el string que viaja a Shopify reconstruye ese mismo número.
      expect(Math.round(Number(usdMilliToAmountString(esperadoMilli)) * 1000)).toBe(esperadoMilli);
    }
  });

  it('detecta el resto cuando lo hay, para que el test de arriba sirva', () => {
    expect(needsRounding(175_000)).toBe(false);
    expect(needsRounding(1_005)).toBe(true); // USD 1,005 → se cobraría 1,01
  });
});

describe('qué estado acredita', () => {
  it('sólo ACTIVE: es el único que significa "Shopify ya le cobró"', () => {
    expect(isPaidStatus('ACTIVE')).toBe(true);
    for (const s of ['PENDING', 'DECLINED', 'EXPIRED', 'ACCEPTED', null, undefined, '']) {
      expect(isPaidStatus(s as string), `${s} no debería acreditar`).toBe(false);
    }
  });

  it('DECLINED y EXPIRED son terminales; PENDING no', () => {
    expect(isDeadStatus('DECLINED')).toBe(true);
    expect(isDeadStatus('EXPIRED')).toBe(true);
    expect(isDeadStatus('PENDING')).toBe(false);
    expect(isDeadStatus('ACTIVE')).toBe(false);
  });

  it('ACCEPTED está deprecado y NO acredita: si Shopify lo mandara, no cobró', () => {
    expect(isPaidStatus('ACCEPTED')).toBe(false);
    expect(isDeadStatus('ACCEPTED')).toBe(false);
  });
});

describe('la mutación', () => {
  it('manda los cuatro argumentos del contrato y pide confirmationUrl', () => {
    for (const frag of [
      '$name: String!',
      '$price: MoneyInput!',
      '$returnUrl: URL!',
      '$test: Boolean',
      'confirmationUrl',
      'userErrors',
    ]) {
      expect(APP_PURCHASE_ONE_TIME_CREATE).toContain(frag);
    }
  });

  it('el precio de lista más caro y el más barato caben en centavos', () => {
    const primero = Number(PRICING_TIERS[0].unitPriceUsdMilli);
    const ultimo = Number(PRICING_TIERS[PRICING_TIERS.length - 1].unitPriceUsdMilli);
    // 0,50 sí; 0,110 sí. El caso incómodo es 0,175 — por eso se cobra el
    // TOTAL del pack (1000 × 0,175 = 175,00) y nunca el unitario suelto.
    expect(needsRounding(primero)).toBe(false);
    expect(needsRounding(ultimo)).toBe(false);
    expect(needsRounding(175)).toBe(true);
    expect(needsRounding(1000 * 175)).toBe(false);
  });
});
