import { describe, it, expect } from 'vitest';
import { codDeLaFuenteDashboard } from '../dashboard/orders';

/**
 * El contrareembolso de la fuente dashboard (DEPO). Lo que se prueba acá es la
 * PROPIEDAD DE SEGURIDAD que hace que este cambio no pueda romper nada: con el
 * interruptor de la tienda apagado, el resultado es null pase lo que pase, y un
 * null hace que `planDeCod` devuelva `esCod:false` y el envío salga como flete
 * común — o sea, exactamente como salía antes de que este campo existiera.
 */
const pedido = (cod?: number | null) => ({ cod_amount: cod });

describe('codDeLaFuenteDashboard — el interruptor manda', () => {
  it('apagado: null aunque el dashboard mande un monto', () => {
    expect(codDeLaFuenteDashboard({ codEnabled: false, order: pedido(2022) })).toBeNull();
  });

  it('sin definir (tenant viejo): también null, falla cerrado', () => {
    expect(codDeLaFuenteDashboard({ codEnabled: null, order: pedido(2022) })).toBeNull();
    expect(codDeLaFuenteDashboard({ codEnabled: undefined, order: pedido(2022) })).toBeNull();
  });

  it('prendido: pasa el monto tal cual', () => {
    expect(codDeLaFuenteDashboard({ codEnabled: true, order: pedido(2022) })).toBe(2022);
  });

  it('prendido pero el pedido no lleva cobro: null', () => {
    expect(codDeLaFuenteDashboard({ codEnabled: true, order: pedido(null) })).toBeNull();
    expect(codDeLaFuenteDashboard({ codEnabled: true, order: pedido(undefined) })).toBeNull();
    expect(codDeLaFuenteDashboard({ codEnabled: true, order: {} })).toBeNull();
  });

  it('no valida el número: eso lo hace planDeCod antes de tocar el formulario', () => {
    // Un monto imposible pasa por acá y lo frena el eslabón siguiente. Está
    // documentado a propósito: una sola función decide qué es un COD válido.
    expect(codDeLaFuenteDashboard({ codEnabled: true, order: pedido(-5) })).toBe(-5);
  });
});
