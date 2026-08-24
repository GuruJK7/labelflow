import { describe, it, expect } from 'vitest';
import { code128bAnchos, code128bSvg, code128bValido } from '../self-delivery/code128';

/** Anchos -> bitstream ("1"=barra, "0"=espacio), que es como se documenta el estandar. */
function aBits(anchos: number[]): string {
  return anchos.map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(w)).join('');
}

describe('Code 128 subset B', () => {
  it('arranca con el patron START B del estandar', () => {
    const bits = aBits(code128bAnchos('A'));
    expect(bits.startsWith('11010010000')).toBe(true);
  });

  it('termina con el patron STOP del estandar', () => {
    const bits = aBits(code128bAnchos('A'));
    expect(bits.endsWith('1100011101011')).toBe(true);
  });

  it('calcula el checksum del vector "Wikipedia" (documentado = 88)', () => {
    // Reconstruimos el checksum desde los anchos: es el penultimo simbolo.
    const anchos = code128bAnchos('Wikipedia');
    // 6 anchos por simbolo; el STOP (ultimo) tiene 7.
    const sinStop = anchos.slice(0, anchos.length - 7);
    const ultimo = sinStop.slice(-6).join('');
    // valor 88 -> patron '421211'
    expect(ultimo).toBe('421211');
  });

  it('cada simbolo de datos mide 11 modulos y el STOP 13', () => {
    const anchos = code128bAnchos('LF-3K7QP2');
    const total = anchos.reduce((a, b) => a + b, 0);
    // start + 9 datos + checksum = 11 simbolos de 11 modulos, + stop de 13
    expect(total).toBe(11 * 11 + 13);
  });

  it('el bitstream siempre empieza en barra y termina en barra', () => {
    const bits = aBits(code128bAnchos('LF-ABC123'));
    expect(bits[0]).toBe('1');
    expect(bits[bits.length - 1]).toBe('1');
  });

  it('codigos distintos dan simbolos distintos', () => {
    expect(aBits(code128bAnchos('LF-0001'))).not.toBe(aBits(code128bAnchos('LF-0002')));
  });

  it('acepta el ASCII imprimible y rechaza lo que el subset B no cubre', () => {
    expect(code128bValido('LF-3K7QP2')).toBe(true);
    expect(code128bValido('abc XYZ 123 -_.')).toBe(true);
    expect(code128bValido('')).toBe(false);
    expect(code128bValido('café')).toBe(false); // é esta fuera de 32..126
    expect(code128bValido('a\nb')).toBe(false);
    expect(() => code128bAnchos('café')).toThrow();
  });

  it('el SVG tiene el ancho que corresponde a los modulos + quiet zone', () => {
    const { svg, anchoPx, altoPx } = code128bSvg('LF-3K7QP2', { alto: 60, moduloPx: 2, quietZone: 10 });
    const modulos = code128bAnchos('LF-3K7QP2').reduce((a, b) => a + b, 0);
    expect(anchoPx).toBe((modulos + 20) * 2);
    expect(altoPx).toBe(60);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('shape-rendering="crispEdges"');
    // La quiet zone tiene que existir: la primera barra no puede estar en x=0.
    expect(svg).toContain('<rect x="20"');
  });

  it('dibuja una barra por cada ancho de indice par', () => {
    const anchos = code128bAnchos('LF-1');
    const { svg } = code128bSvg('LF-1');
    const barras = (svg.match(/<rect /g) ?? []).length;
    expect(barras).toBe(Math.ceil(anchos.length / 2));
  });
});
