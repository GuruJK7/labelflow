import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PricingSelector } from '@/app/_components/PricingSelector';
import type { Currency } from '@/lib/pricing';

/**
 * Render real del simulador de precios de la LANDING (PR #13 sobre D35).
 *
 * Por qué existe aparte del test del selector del dashboard: son dos pantallas
 * distintas con la misma tabla, y el modo de romperlas es el mismo — que la
 * landing publique un número que la caja no cobra. Los valores de acá se
 * re-derivaron a mano contra la escalera, no se copiaron de la salida:
 *
 *   250 envíos/mes → escalón "Desde 250", total del mes = min sobre tramos de
 *   max(250, t.min) × t.precio = 250 × 0,300 = USD 75,00 → $U 3.000 a 40.
 *   Ahorro contra el primer escalón: 250 × 0,500 − 75,00 = USD 50,00 → $U 2.000.
 *   Empujón: a 500 el efectivo baja de 0,300 a 0,250 → 0,050 menos por envío.
 */
const RATE_MILLI = 40_000;

function render(currency?: Currency, largePacks = false) {
  return renderToStaticMarkup(
    createElement(PricingSelector, {
      rateMilliValue: RATE_MILLI,
      rateLabel: '40',
      largePacks,
      currency,
      onCurrencyChange: vi.fn(),
    }),
  );
}

describe('PricingSelector (landing)', () => {
  it('arranca en pesos, que es el default de quien entra por primera vez', () => {
    const html = render();
    expect(html).toContain('$U 12,00'); // por envío
    expect(html).toContain('$U 3.000'); // el mes entero
    expect(html).toContain('$U 2.000'); // ahorro vs. primer escalón
    expect(html).toContain('Desde 250 envíos por mes');
    expect(html).not.toContain('USD 0,30');
  });

  it('en dólares muestra la misma cotización sin convertir dos veces', () => {
    const html = render('USD');
    expect(html).toContain('USD 0,30');
    expect(html).toContain('USD 75,00');
    expect(html).toContain('USD 50,00');
  });

  it('empuja al escalón siguiente con el ahorro REAL, no el de lista', () => {
    const html = render('USD');
    expect(html).toContain('250 envíos más');
    expect(html).toContain('escalón de 500');
    expect(html).toContain('USD 0,05 menos');
  });

  it('el precio de lista del pie sale de la tabla, no de una constante suelta', () => {
    expect(render('USD')).toContain('USD 0,50');
    expect(render('UYU')).toContain('$U 20,00');
  });

  it('dice en qué moneda se cobra de verdad', () => {
    expect(render('UYU')).toContain('40 UYU/USD');
    expect(render('USD')).toContain('MercadoPago cobra en pesos');
  });

  it('no publica precios en pesos calculados con un tipo distinto al del checkout', () => {
    // Mismo volumen, tipo movido: el peso tiene que moverse con él.
    const html = renderToStaticMarkup(
      createElement(PricingSelector, {
        rateMilliValue: 45_000,
        rateLabel: '45',
        largePacks: false,
        currency: 'UYU' as Currency,
        onCurrencyChange: vi.fn(),
      }),
    );
    expect(html).toContain('$U 3.375'); // 75,00 × 45
    expect(html).toContain('45 UYU/USD');
  });
});

/**
 * Los dos estados que la auditoría del 2026-09-02 encontró rotos en producción:
 * el "escribinos" del precio a medida era texto muerto, y el empujón al escalón
 * siguiente prometía sin salvedad el descuento de un escalón que no se puede
 * comprar en autoservicio.
 */
describe('PricingSelector: los estados de volumen alto', () => {
  function conVolumen(v: number, currency: Currency = 'USD') {
    // El estado del slider es interno; se llega al volumen alto por los presets,
    // así que se renderiza y se busca en el markup el estado que corresponde.
    return renderToStaticMarkup(
      createElement(PricingSelector, {
        rateMilliValue: RATE_MILLI,
        rateLabel: '40',
        largePacks: false,
        currency,
        onCurrencyChange: vi.fn(),
        initialVolume: v,
      } as never),
    );
  }

  it('el volumen alto entra por el alta, no por WhatsApp', () => {
    const html = conVolumen(2500);
    expect(html).toContain('el precio se arma a medida');
    expect(html).toMatch(/<a[^>]+href="\/signup"[^>]*>creá tu cuenta<\/a>/);
    // El WhatsApp es soporte: no puede aparecer como canal de venta.
    expect(html).not.toContain('wa.me');
  });

  it('en el techo del autoservicio el empujón aclara que ese escalón es a medida', () => {
    const html = conVolumen(1000);
    expect(html).toContain('escalón de 2.500');
    expect(html).toContain('se ajusta a medida, desde tu cuenta');
    expect(html).not.toContain('wa.me');
  });

  it('un escalón comprable no arrastra la salvedad de "a medida"', () => {
    const html = conVolumen(250);
    expect(html).toContain('escalón de 500');
    expect(html).not.toContain('se ajusta a medida');
  });

  it('el simulador no ofrece ningún canal de contacto: la puerta es el alta', () => {
    for (const v of [50, 250, 1000, 2500, 5000]) {
      expect(conVolumen(v)).not.toContain('wa.me');
    }
  });
});
