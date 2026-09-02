import { describe, it, expect } from 'vitest';
import {
  PACK_SHIPMENTS,
  SELF_SERVE_PACK_SHIPMENTS,
  LARGE_PACK_SHIPMENTS,
  LARGE_PACKS_ENV,
  getPack,
  largePacksEnabled,
  listPacks,
  listPricingSteps,
  packIdList,
  purchasablePackShipments,
  quoteForVolume,
} from '@/lib/credit-packs';
import { BASE_USD_UYU_RATE_MILLI, PRICING_TIERS, periodTotalUsdMilli } from '@/lib/pricing';

/**
 * 🔴 QUÉ PROTEGE ESTE ARCHIVO (revisión 2026-09-02).
 *
 * Un paquete cobra el precio del escalón aplicado al TAMAÑO DEL PACK, los
 * envíos se acreditan 1:1 y no vencen. Comprar un paquete grande compra el
 * precio de un escalón alto para siempre, sin tener nunca ese volumen mensual.
 * El mecanismo ya existía y topeaba en 64 % de descuento (`pack_1000`, 0,18);
 * los dos escalones nuevos de D35 lo llevarían a 78 % (`pack_5000`, 0,11).
 *
 * Mientras Adrian no firme, la escalera de D35 queda completa y visible —es el
 * precio por VOLUMEN MENSUAL, que es lo que D35 decidió— pero el catálogo que
 * se compra sin hablar con nadie queda como estaba.
 */
const RATE = BASE_USD_UYU_RATE_MILLI;

describe('la env que abre los paquetes grandes', () => {
  it('sólo el string exacto "true" los habilita', () => {
    expect(largePacksEnabled({})).toBe(false);
    expect(largePacksEnabled({ [LARGE_PACKS_ENV]: 'true' })).toBe(true);
    for (const flojo of ['TRUE', 'True', '1', 'yes', 'si', ' true', '']) {
      expect(largePacksEnabled({ [LARGE_PACKS_ENV]: flojo }), flojo).toBe(false);
    }
  });

  it('el catálogo comprable por default es el de siempre; con la env, los ocho', () => {
    expect([...SELF_SERVE_PACK_SHIPMENTS]).toEqual([10, 50, 100, 250, 500, 1000]);
    expect([...LARGE_PACK_SHIPMENTS]).toEqual([2500, 5000]);
    expect([...SELF_SERVE_PACK_SHIPMENTS, ...LARGE_PACK_SHIPMENTS]).toEqual([...PACK_SHIPMENTS]);
    expect(purchasablePackShipments({ largePacks: false })).toEqual([...SELF_SERVE_PACK_SHIPMENTS]);
    expect(purchasablePackShipments({ largePacks: true })).toEqual([...PACK_SHIPMENTS]);
  });
});

describe('con la env apagada (el default de hoy)', () => {
  it('el catálogo tiene seis paquetes y ninguno es de USD 550', () => {
    const packs = listPacks(RATE);
    expect(packs.map((p) => p.id)).toEqual([
      'pack_10',
      'pack_50',
      'pack_100',
      'pack_250',
      'pack_500',
      'pack_1000',
    ]);
    const masCaro = Math.max(...packs.map((p) => p.totalPriceUsdMilli));
    expect(masCaro).toBe(180_000); // USD 180, no USD 550
  });

  it('el checkout rechaza un ?pack=pack_5000 escrito a mano', () => {
    // Es el único punto por el que se crea una compra: si acá pasa, se vendió.
    expect(getPack('pack_2500', RATE)).toBeNull();
    expect(getPack('pack_5000', RATE)).toBeNull();
    expect(packIdList()).toBe('pack_10, pack_50, pack_100, pack_250, pack_500, pack_1000');
    expect(packIdList()).not.toContain('pack_5000');
  });

  it('EL TECHO DEL AGUJERO NO CRECE: el mejor precio comprable sigue siendo 0,18', () => {
    const base = Number(PRICING_TIERS[0].unitPriceUsdMilli); // 0,50
    const mejor = Math.min(...listPacks(RATE).map((p) => p.pricePerShipmentUsdMilli));
    expect(mejor).toBe(180); // el de pack_1000, igual que antes de D35
    expect(Math.round((1 - mejor / base) * 100)).toBe(64); // no 78
  });

  it('MEDIDO: el cliente de 60 envíos/mes ya no puede comprarse 0,11 para siempre', () => {
    // Con la env prendida: pack_5000 = USD 550, le dura 5000/60 = 83,3 meses,
    // y su mes real es periodTotal(60) = USD 25,20 → debería pagar USD 2.100.
    const mesReal = Number(periodTotalUsdMilli(60)); // 25.200 milésimos
    expect(mesReal).toBe(25_200);
    const grande = getPack('pack_5000', RATE, { largePacks: true })!;
    const mesesQueDura = grande.shipments / 60;
    const deberiaPagar = Math.round((mesesQueDura * mesReal) / 1000);
    expect(deberiaPagar).toBe(2_100); // USD 2.100
    expect(grande.totalPriceUsdMilli / 1000).toBe(550); // paga USD 550: -73,8 %

    // Con la env apagada, lo más barato que puede comprarse es 0,18 por envío.
    const topeHoy = Math.min(...listPacks(RATE).map((p) => p.pricePerShipmentUsdMilli));
    expect(topeHoy).toBe(180);
  });

  it('la ESCALERA sigue mostrando los ocho escalones: D35 no se recorta', () => {
    // Lo que se gatea es qué se puede COMPRAR, no el tarifario por volumen.
    expect(listPricingSteps(RATE).map((s) => s.minShipments)).toEqual([
      0, 50, 100, 250, 500, 1000, 2500, 5000,
    ]);
    expect(listPricingSteps(RATE).at(-1)!.unitPriceUsdMilli).toBe(110);
  });

  it('un volumen por encima del pack más grande se marca como "a medida"', () => {
    const q = quoteForVolume(2500, RATE);
    expect(q.needsCustomQuote).toBe(true);
    expect(q.pack.id).toBe('pack_1000');
    expect(q.quantity).toBe(3);
    // El simulador sigue diciendo la verdad sobre el mes: USD 350 a 0,14.
    expect(q.monthlyTotalUsdMilli).toBe(350_000);
    expect(q.effectiveUnitUsdMilli).toBe(140);
    // Pero comprando paquetes sueltos pagaría más, y por eso la UI manda a
    // hablar en vez de empujar tres compras.
    expect(q.totalPriceUsdMilli).toBe(540_000);
    expect(q.totalPriceUsdMilli).toBeGreaterThan(q.monthlyTotalUsdMilli);
  });

  it('hasta 1000 nada cambia: el mismo pack y el mismo precio que con la env prendida', () => {
    for (const n of [1, 10, 49, 50, 100, 250, 500, 800, 1000]) {
      const off = quoteForVolume(n, RATE);
      const on = quoteForVolume(n, RATE, { largePacks: true });
      expect(off.pack.id, `n=${n}`).toBe(on.pack.id);
      expect(off.totalPriceUsdMilli, `n=${n}`).toBe(on.totalPriceUsdMilli);
      expect(off.needsCustomQuote, `n=${n}`).toBe(false);
    }
  });
});
