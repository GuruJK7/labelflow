import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Render real del selector de volumen (D34/D35) en node. Estado inicial: 100
 * envíos por mes → escalón de 100, USD 0,37 por envío, USD 37,00 el mes,
 * 1.480 UYU al tipo base. El botón de Whop sólo aparece si el pack tiene link.
 *
 * MONEDA. El componente arranca en UYU (el default: el cliente es uruguayo) y
 * la elección se recuerda en localStorage vía `useCurrency`.
 * `renderToStaticMarkup` no corre efectos, así que sin props siempre sale el
 * default — que es exactamente lo que ve alguien que entra por primera vez.
 * Para mirar la otra moneda se pasa `currency` explícito, que es para lo que
 * existe esa prop.
 */
import { VolumeSelector } from '@/app/(dashboard)/settings/billing/_components/VolumeSelector';
import type { Currency } from '@/lib/pricing';

/** 40 UYU/USD en milésimos: el tipo base de D35. */
const RATE_MILLI = 40_000;

function render(
  whopPacks: string[],
  rateMilli = RATE_MILLI,
  rateLabel = '40',
  largePacks = false,
  currency?: Currency,
) {
  return renderToStaticMarkup(
    createElement(VolumeSelector, {
      usdUyuRateMilli: rateMilli,
      usdUyuRateLabel: rateLabel,
      largePacks,
      whopPacks,
      loadingPackId: null,
      onPayMercadoPago: vi.fn(),
      onPayWhop: vi.fn(),
      currency,
      onCurrencyChange: vi.fn(),
    }),
  );
}

const enUsd = (whopPacks: string[] = []) => render(whopPacks, RATE_MILLI, '40', false, 'USD');

describe('<VolumeSelector>', () => {
  it('muestra la pregunta, los presets, el escalón actual, el precio y el total', () => {
    const html = render([]);
    expect(html).toContain('¿Cuántos envíos hacés por mes?');
    for (const n of [50, 100, 250, 500, 1000, 2500, 5000]) {
      expect(html).toContain(`>${n.toLocaleString('es-UY')}</button>`);
    }
    // Por default en pesos: 0,37 × 40 = 14,80 por envío, 1.480 el mes.
    expect(html).toContain('$U 14,80');
    expect(html).toContain('$U 1.480');
    // Y el dólar sigue a la vista, en chico: elegir una moneda no esconde la otra.
    expect(html).toContain('USD 37,00');
    expect(html).toContain('Desde 100 envíos por mes');
    expect(html).toContain('Pagar con MercadoPago');
    expect(html).toContain('Los envíos no vencen y se comparten entre todas tus tiendas');
  });

  it('en USD muestra el precio de lista sin convertir, con el peso al lado', () => {
    const html = enUsd();
    expect(html).toContain('USD 0,37');
    expect(html).toContain('USD 37,00');
    expect(html).toContain('$U 1.480'); // la otra moneda, en chico
  });

  it('el selector de moneda es un radiogroup con USD y UYU, y arranca en UYU', () => {
    const html = render([]);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Ver los precios en"');
    // Dos radios: el activo con aria-checked y tabulable, el otro fuera del tab.
    expect(html).toContain('aria-checked="true" tabindex="0"');
    expect(html).toContain('aria-checked="false" tabindex="-1"');
    expect(html).toContain('>UYU</button>');
    expect(html).toContain('>USD</button>');
  });

  it('la escalera completa: ocho escalones, en la moneda elegida', () => {
    // 0,175 y no 0,18: el precio por envío se muestra exacto en milésimos.
    const usd = enUsd();
    for (const precio of [
      'USD 0,50',
      'USD 0,42',
      'USD 0,37',
      'USD 0,30',
      'USD 0,25',
      'USD 0,175',
      'USD 0,14',
      'USD 0,11',
    ]) {
      expect(usd, precio).toContain(precio);
    }

    // Los mismos ocho al tipo base. El de 1.000 da 7,00 clavados, que es LA
    // razón por la que el escalón bajó a 0,175: con 0,18 daba 7,20.
    const uyu = render([]);
    for (const precio of [
      '$U 20,00',
      '$U 16,80',
      '$U 14,80',
      '$U 12,00',
      '$U 10,00',
      '$U 7,00',
      '$U 5,60',
      '$U 4,40',
    ]) {
      expect(uyu, precio).toContain(precio);
    }

    for (const html of [usd, uyu]) {
      expect(html).toContain('La escalera completa');
      expect(html).toContain('5.000 o más');
      expect(html).toContain('Tu escalón');
    }
    expect(uyu).toContain('en pesos');
    expect(usd).toContain('en dólares');
  });

  it('el mes completo de la tabla, en pesos, es el que cobra el checkout', () => {
    // Los mismos totales que `credit-packs-volume.test.ts` fija para los packs:
    // acá se verifica que la tabla muestre ESOS pesos y no una conversión aparte.
    const html = render([]);
    for (const total of ['$U 840', '$U 1.480', '$U 3.000', '$U 5.000', '$U 7.000', '$U 22.000']) {
      expect(html, total).toContain(total);
    }
  });

  it('empuja al escalón siguiente con el ahorro REAL por envío', () => {
    // Con 100 envíos el efectivo es 0,370; en 250 es 0,300. Ahorro: 0,07.
    expect(enUsd()).toContain('USD 0,07 menos por envío');
    // El mismo ahorro en pesos: 0,07 × 40 = 2,80.
    const uyu = render([]);
    expect(uyu).toContain('150 envíos más');
    expect(uyu).toContain('$U 2,80 menos por envío');
  });

  it('dice que el precio es en dólares y el cobro en pesos, con el tipo de cambio', () => {
    const html = render([], 41_500, '41,5');
    expect(html).toContain('41,5 UYU/USD');
    expect(html).toContain('cobra en pesos');
    // Y los pesos se recalculan con ESE tipo: 37 USD × 41,5 = 1.535,50 → 1.536.
    expect(html).toContain('1.536');
  });

  it('la nota cambia con la moneda y ninguna afirma que el tipo sea el del día', () => {
    expect(render([])).toContain('Los importes en pesos salen del precio de lista en dólares');
    expect(enUsd()).toContain('vas a ver el monto exacto en pesos antes de pagar');
  });

  it('sin link de Whop para el pack → no hay botón de Whop', () => {
    const html = render(['pack_500']);
    expect(html).not.toContain('Pagar con Whop');
  });

  it('con link de Whop para el pack → aparece el botón y la aclaración de moneda', () => {
    const html = render(['pack_100']);
    expect(html).toContain('Pagar con Whop');
    expect(html).toContain('Whop cobra en dólares');
  });

  it('la escalera se ve entera aunque los paquetes grandes no se vendan solos', () => {
    // Lo que se gatea es qué se puede COMPRAR; el tarifario por volumen de D35
    // se sigue mostrando completo, que es lo que Adrian decidió.
    const html = enUsd();
    expect(html).toContain('USD 0,14');
    expect(html).toContain('USD 0,11');
    expect(html).toContain('5.000 o más');
  });

  it('con 100 envíos no aparece el cartel de cotización a medida', () => {
    // El cartel es para volúmenes por encima del paquete más grande comprable
    // (`needsCustomQuote`). Que no salga acá es lo único que este render puede
    // afirmar: el estado del selector no se puede cambiar sin eventos. Que SÍ
    // salga a partir de 2.500 está fijado sobre la cotización, en
    // `credit-packs-selfserve.test.ts`.
    expect(render([])).not.toContain('se arma a medida');
  });

  it('sin emojis en el copy', () => {
    const html = render(['pack_100']);
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html)).toBe(false);
  });
});
