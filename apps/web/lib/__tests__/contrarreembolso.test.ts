import { describe, it, expect } from 'vitest';
import { esContrareembolso, etiquetaDePago, COD_MONTO_MAX } from '../contrarreembolso';

/**
 * NOTA DE COBERTURA. La regla que de verdad importa vive en classifyStuck()
 * (apps/web/lib/stuck-labels.ts): un contrareembolso huérfano se retiene como
 * 'orphan' en vez de reintentarse, porque un reintento puede cobrarle la
 * mercadería DOS VECES al cliente final.
 *
 * Ese módulo NO se puede importar desde vitest: arrastra `@/lib/db` y el repo no
 * tiene vitest.config con el alias `@` (por eso no existe ningún test de
 * stuck-labels hoy). Agregar esa config tocaría la infraestructura de los 26
 * tests que ya pasan, así que se dejó como está.
 *
 * Lo que sí se testea acá es el predicado del que depende esa regla, que es donde
 * está toda la decisión: si esContrareembolso() acierta, classifyStuck acierta.
 */
describe('esContrareembolso — el predicado del que depende la regla anti-doble-cobro', () => {
  it('un monto normal es contrareembolso', () => {
    expect(esContrareembolso(1490)).toBe(true);
  });
  it('null es el caso por defecto de todos los pedidos viejos', () => {
    expect(esContrareembolso(null)).toBe(false);
    expect(esContrareembolso(undefined)).toBe(false);
  });
  it('todo lo dudoso es NO (no emitir un COD equivocado)', () => {
    for (const v of [0, -1, NaN, Infinity, COD_MONTO_MAX + 1, 0.4]) {
      expect(esContrareembolso(v as number)).toBe(false);
    }
  });
  it('acepta el tope exacto', () => {
    expect(esContrareembolso(COD_MONTO_MAX)).toBe(true);
  });
  it('coincide con el criterio del worker (misma regla duplicada a propósito)', () => {
    // Si esto se desalinea, la UI y el formulario de DAC discrepan.
    expect(esContrareembolso(990)).toBe(true);
    expect(esContrareembolso(990.6)).toBe(true); // redondea a 991
  });
});

describe('etiquetaDePago — no romper lo que ya se mostraba', () => {
  it('sin COD, la etiqueta binaria de siempre', () => {
    expect(etiquetaDePago('REMITENTE', null)).toBe('Remitente');
    expect(etiquetaDePago('DESTINATARIO', null)).toBe('Destinatario');
    expect(etiquetaDePago(null, null)).toBe('Destinatario');
  });
  it('con COD gana Contrareembolso', () => {
    expect(etiquetaDePago('DESTINATARIO', 990)).toBe('Contrareembolso');
    expect(etiquetaDePago('REMITENTE', 990)).toBe('Contrareembolso');
  });
  it('un COD inválido no se muestra como contrareembolso', () => {
    expect(etiquetaDePago('DESTINATARIO', 0)).toBe('Destinatario');
  });
});
