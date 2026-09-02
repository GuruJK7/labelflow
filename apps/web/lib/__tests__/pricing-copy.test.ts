import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { VolumeSelector } from '@/app/(dashboard)/settings/billing/_components/VolumeSelector';

/**
 * El copy de precios no puede afirmar algo falso sobre plata (revisión 2026-09-02).
 *
 * `USD_UYU_RATE` es una CONSTANTE que Adrian mueve a mano — el propio
 * `.env.example` dice "NO es la cotizacion del dia" — y hoy ni siquiera está
 * cargada en Vercel, así que se cobra al tipo base 40 mientras el mercado anda
 * por otro lado. La pantalla donde el cliente aprieta "Pagar" decía "al tipo de
 * cambio del día (40 UYU/USD hoy)": eso es afirmarle al cliente que el número
 * que ve es la cotización de hoy, y no lo es.
 *
 * Este test vigila el TEXTO, no el cálculo: es la única parte del precio que
 * ningún otro test mira y la única que el cliente realmente lee.
 */

const BILLING_DIR = join(__dirname, '..', '..', 'app', '(dashboard)', 'settings', 'billing');
const SOURCES = [
  join(BILLING_DIR, 'page.tsx'),
  join(BILLING_DIR, '_components', 'VolumeSelector.tsx'),
];

/**
 * Frases que AFIRMAN que el tipo es el del día. "no es la cotización del día"
 * está permitido a propósito: niega, no afirma. Por eso los patrones incluyen
 * la preposición que las convierte en afirmación ("al tipo de cambio del día").
 */
const AFIRMACIONES_FALSAS = [
  /al tipo de cambio del d[ií]a/i,
  /al tipo de cambio de hoy/i,
  /tipo de cambio de hoy/i,
  /al tipo del d[ií]a/i,
  /UYU\/USD hoy/i,
  /cotizaci[oó]n del d[ií]a(?!\))/i, // sólo si no viene precedida de "no es la"
];

function render(rateLabel = '40') {
  return renderToStaticMarkup(
    createElement(VolumeSelector, {
      usdUyuRateMilli: 40_000,
      usdUyuRateLabel: rateLabel,
      largePacks: false,
      whopPacks: [],
      loadingPackId: null,
      onPayMercadoPago: vi.fn(),
      onPayWhop: vi.fn(),
    }),
  );
}

describe('copy del tipo de cambio en /settings/billing', () => {
  it('el HTML que ve el cliente no dice que el tipo sea el del día', () => {
    const html = render();
    for (const patron of AFIRMACIONES_FALSAS) {
      // "no es la cotización del día" es una negación válida: se recorta antes.
      const sinNegaciones = html.replace(/no es la cotizaci[oó]n del d[ií]a/gi, '');
      expect(sinNegaciones, `el copy afirma ${patron}`).not.toMatch(patron);
    }
  });

  it('dice que es un tipo de referencia y muestra cuál es', () => {
    const html = render('41,5');
    expect(html).toContain('de referencia');
    expect(html).toContain('41,5 UYU/USD');
  });

  it('avisa explícitamente que NO es la cotización del día', () => {
    expect(render()).toContain('no es la');
  });

  it('ningún fuente de la pantalla de compra afirma "tipo de cambio del día"', () => {
    for (const file of SOURCES) {
      const src = readFileSync(file, 'utf8').replace(/no es la\s+cotizaci[oó]n del d[ií]a/gi, '');
      for (const patron of AFIRMACIONES_FALSAS) {
        expect(src, `${file} afirma ${patron}`).not.toMatch(patron);
      }
    }
  });
});
