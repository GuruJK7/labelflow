import { describe, it, expect } from 'vitest';
import {
  planDeCod, esContrareembolso, etiquetaDePago,
  DAC_TIPO_GUIA_CONTRAREEMBOLSO, COD_MONTO_MAX,
} from '../contrarreembolso';

describe('planDeCod — cuándo SÍ es contrareembolso', () => {
  it('un monto normal produce TipoGuia=6 y el costo como dígitos', () => {
    expect(planDeCod({ codAmount: 1490 })).toEqual({
      esCod: true, tipoGuia: '6', costoMercaderia: '1490', monto: 1490,
    });
  });
  it('el value coincide con el leído del DOM de DAC', () => {
    expect(DAC_TIPO_GUIA_CONTRAREEMBOLSO).toBe('6');
  });
  it('redondea decimales al peso (DAC acepta pattern="[0-9]*")', () => {
    expect(planDeCod({ codAmount: 990.4 })).toMatchObject({ costoMercaderia: '990' });
    expect(planDeCod({ codAmount: 990.6 })).toMatchObject({ costoMercaderia: '991' });
  });
  it('nunca emite separador de miles, decimales ni signo', () => {
    const p = planDeCod({ codAmount: 125000 });
    expect(p.esCod && p.costoMercaderia).toBe('125000');
    expect(p.esCod && /^[0-9]+$/.test(p.costoMercaderia)).toBe(true);
  });
  it('acepta el tope exacto', () => {
    expect(planDeCod({ codAmount: COD_MONTO_MAX }).esCod).toBe(true);
  });
});

describe('planDeCod — todo lo dudoso NO es contrareembolso', () => {
  // La asimetría es a propósito: emitir un COD equivocado cobra mal a un cliente real.
  const noSon: Array<[string, unknown]> = [
    ['null (el caso por defecto de todos los pedidos viejos)', null],
    ['undefined (el campo no vino en el select)', undefined],
    ['cero', 0],
    ['negativo', -500],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['string', '1490'],
    ['por encima del tope de cordura', COD_MONTO_MAX + 1],
    ['decimal que redondea a cero', 0.4],
  ];
  for (const [nombre, v] of noSon) {
    it(`${nombre} → esCod false`, () => {
      expect(planDeCod({ codAmount: v as number }).esCod).toBe(false);
    });
  }
});

describe('no romper lo existente', () => {
  it('sin codAmount, una guía se comporta como siempre', () => {
    expect(esContrareembolso({})).toBe(false);
    expect(esContrareembolso({ codAmount: null })).toBe(false);
  });
  it('la etiqueta binaria vieja se conserva cuando no hay COD', () => {
    expect(etiquetaDePago('REMITENTE', {})).toBe('Remitente');
    expect(etiquetaDePago('DESTINATARIO', {})).toBe('Destinatario');
    expect(etiquetaDePago(null, {})).toBe('Destinatario');
  });
  it('con COD, la etiqueta gana sobre el paymentType', () => {
    expect(etiquetaDePago('DESTINATARIO', { codAmount: 990 })).toBe('Contrareembolso');
    expect(etiquetaDePago('REMITENTE', { codAmount: 990 })).toBe('Contrareembolso');
  });
  it('un COD invalido NO se muestra como contrareembolso', () => {
    expect(etiquetaDePago('DESTINATARIO', { codAmount: 0 })).toBe('Destinatario');
  });
});
