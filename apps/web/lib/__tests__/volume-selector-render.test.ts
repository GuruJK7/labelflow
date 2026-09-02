import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Render real del selector de volumen (D34) en node. Estado inicial: 100
 * envíos por mes → pack_100 a $15, total $1500, ahorro $500, tramo siguiente
 * a 150 envíos más. El botón de Whop sólo aparece si el pack tiene link.
 */
import { VolumeSelector } from '@/app/(dashboard)/settings/billing/_components/VolumeSelector';

function render(whopPacks: string[]) {
  return renderToStaticMarkup(
    createElement(VolumeSelector, {
      whopPacks,
      loadingPackId: null,
      onPayMercadoPago: vi.fn(),
      onPayWhop: vi.fn(),
    }),
  );
}

describe('<VolumeSelector>', () => {
  it('muestra la pregunta, los presets, el pack recomendado, precio, total, ahorro y tramo siguiente', () => {
    const html = render([]);
    expect(html).toContain('¿Cuántos envíos hacés por mes?');
    for (const n of [50, 100, 250, 500, 1000]) expect(html).toContain(`>${n.toLocaleString('es-UY')}</button>`);
    expect(html).toContain('pack de 100 envíos');
    expect(html).toContain('$15');
    expect(html).toContain(`$${(1500).toLocaleString('es-UY')}`);
    expect(html).toContain('Desde 100 envíos por mes');
    expect(html).toContain('Ahorrás $500 UYU frente a comprar de a 10');
    expect(html).toContain('150 envíos más');
    expect(html).toContain('pack de 250');
    expect(html).toContain('Pagar con MercadoPago');
    expect(html).toContain('Los envíos no vencen y se comparten entre todas tus tiendas');
  });

  it('sin link de Whop para el pack → no hay botón de Whop', () => {
    const html = render(['pack_500']);
    expect(html).not.toContain('Pagar con Whop');
  });

  it('con link de Whop para el pack → aparece el botón y la aclaración de moneda', () => {
    const html = render(['pack_100']);
    expect(html).toContain('Pagar con Whop');
    expect(html).toContain('dólares');
  });

  it('sin emojis en el copy', () => {
    const html = render(['pack_100']);
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html)).toBe(false);
  });
});
