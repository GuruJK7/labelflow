import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { periodTotalUsdMilli, formatUsdMilli } from '@/lib/pricing';

/**
 * El modal de "Te quedaste sin envíos".
 *
 * 🔴 POR QUÉ ESTE TEST. El botón decía «Comprar 100 envíos · 1.500 UYU`,
 * escrito a mano. Dos defectos en una línea:
 *
 *   1. Un precio en pesos horneado en el código se desactualiza solo la
 *      primera vez que alguien mueve `USD_UYU_RATE`.
 *   2. A un comerciante que instaló la app desde el App Store le ofrecía un
 *      precio del riel de MercadoPago — que es exactamente lo que prohíbe el
 *      requisito 1.2. Apareció grabando el screencast de revisión, encima de
 *      la pantalla de compra: el modal tapaba la pantalla y mostraba pesos.
 *
 * El test mira la fuente porque el componente se monta detrás de estado de
 * cliente y `renderToStaticMarkup` no lo abre; lo que tiene que ser imposible
 * es que vuelva a aparecer un monto en pesos escrito a mano.
 */
const CRUDO = readFileSync(
  join(__dirname, '..', '..', 'components', 'onboarding', 'CreditExhaustedModal.tsx'),
  'utf8',
);

/**
 * La fuente SIN comentarios. Los comentarios explican justamente el bug —
 * citan «1.500 UYU»— así que un test que mire el archivo crudo se dispara
 * contra su propia documentación. Lo que importa es lo que se RENDERIZA.
 */
const FUENTE = CRUDO
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')  // comentarios JSX
  .replace(/\/\*[\s\S]*?\*\//g, '')        // comentarios de bloque
  .replace(/^\s*\/\/.*$/gm, '');              // comentarios de línea

describe('modal de saldo agotado', () => {
  it('no ofrece ningún precio en pesos', () => {
    const enPesos = FUENTE.split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /\bUYU\b/.test(l));
    expect(enPesos.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });

  it('no tiene ningún monto escrito a mano', () => {
    // Un número con separador de miles en el JSX es, casi siempre, un precio.
    expect(FUENTE).not.toMatch(/>\s*[^<]*\d\.\d{3}[^<]*</);
  });

  it('el precio sale de la misma tabla que cobra la caja', () => {
    expect(CRUDO).toContain('periodTotalUsdMilli(PACK_TEASER_SHIPMENTS)');
    // Y ese total es el que se espera para el pack de 100: 100 × 0,37.
    expect(formatUsdMilli(periodTotalUsdMilli(100))).toBe('37,00');
  });

  it('el botón y el teaser hablan del mismo pack', () => {
    expect(CRUDO).toContain('const PACK_TEASER_SHIPMENTS = 100;');
    expect(FUENTE.split('PACK_TEASER_SHIPMENTS').length).toBeGreaterThanOrEqual(4);
    expect(FUENTE).not.toMatch(/const shipments = \d+;/);
  });
});
