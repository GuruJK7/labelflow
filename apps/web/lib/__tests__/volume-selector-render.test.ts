import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Render real del selector de volumen (D34/D35) en node. Estado inicial: 100
 * envíos por mes → escalón de 100, USD 0,37 por envío, USD 37,00 el mes,
 * 1.480 UYU al tipo base. El botón de Whop sólo aparece si el pack tiene link.
 */
import { VolumeSelector } from '@/app/(dashboard)/settings/billing/_components/VolumeSelector';

/** 40 UYU/USD en milésimos: el tipo base de D35. */
const RATE_MILLI = 40_000;

function render(
  whopPacks: string[],
  rateMilli = RATE_MILLI,
  rateLabel = '40',
  largePacks = false,
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
    }),
  );
}

describe('<VolumeSelector>', () => {
  it('muestra la pregunta, los presets, el escalón actual, el precio en USD y el total', () => {
    const html = render([]);
    expect(html).toContain('¿Cuántos envíos hacés por mes?');
    for (const n of [50, 100, 250, 500, 1000, 2500, 5000]) {
      expect(html).toContain(`>${n.toLocaleString('es-UY')}</button>`);
    }
    expect(html).toContain('USD 0,37');
    expect(html).toContain('USD 37,00');
    expect(html).toContain('Desde 100 envíos por mes');
    expect(html).toContain('1.480'); // el mes en pesos al tipo base
    expect(html).toContain('Pagar con MercadoPago');
    expect(html).toContain('Los envíos no vencen y se comparten entre todas tus tiendas');
  });

  it('muestra la escalera completa de ocho escalones con sus precios', () => {
    const html = render([]);
    // 0,175 y no 0,18: el precio por envío se muestra exacto en milésimos.
    const precios = ['USD 0,50', 'USD 0,42', 'USD 0,37', 'USD 0,30', 'USD 0,25', 'USD 0,175', 'USD 0,14', 'USD 0,11'];
    for (const precio of precios) {
      expect(html, precio).toContain(precio);
    }
    expect(html).toContain('La escalera completa');
    expect(html).toContain('5.000 o más');
    expect(html).toContain('Tu escalón');
  });

  it('empuja al escalón siguiente con el ahorro REAL por envío', () => {
    // Con 100 envíos el efectivo es 0,370; en 250 es 0,300. Ahorro: 0,07.
    const html = render([]);
    expect(html).toContain('150 envíos más');
    expect(html).toContain('USD 0,07 menos por envío');
  });

  it('dice que el precio es en dólares y el cobro en pesos, con el tipo de cambio', () => {
    const html = render([], 41_500, '41,5');
    expect(html).toContain('41,5 UYU/USD');
    expect(html).toContain('cobra en pesos');
    // Y los pesos se recalculan con ESE tipo: 37 USD × 41,5 = 1.535,50 → 1.536.
    expect(html).toContain('1.536');
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
    const html = render([]);
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
