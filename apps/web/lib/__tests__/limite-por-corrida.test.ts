import { describe, it, expect } from 'vitest';
import {
  leerLimitePedido,
  limiteEfectivo,
  hayOverride,
  etiquetaDeLimite,
  TODOS,
} from '../limite-por-corrida';

/**
 * El bug que estos tests fijan: "Todos" (0) era indistinguible de "no elegí
 * nada", así que el botón caía al default de la tienda (5 en Curvadivina, 20 en
 * las otras 31) y despachaba un puñado de pedidos.
 */
describe('leerLimitePedido', () => {
  it('0 es TODOS, no "no pidió nada" — el caso que estaba roto', () => {
    expect(leerLimitePedido({ maxOrders: 0 })).toBe(0);
    expect(leerLimitePedido({ maxOrders: 0 })).not.toBeUndefined();
  });

  it('body sin maxOrders → undefined (manda el default de la tienda)', () => {
    expect(leerLimitePedido({})).toBeUndefined();
    expect(leerLimitePedido(null)).toBeUndefined();
    expect(leerLimitePedido(undefined)).toBeUndefined();
  });

  it('un número válido pasa tal cual', () => {
    for (const n of [1, 3, 5, 10, 20, 50]) expect(leerLimitePedido({ maxOrders: n })).toBe(n);
  });

  it('lo inválido se trata como ausente, no rompe la corrida', () => {
    expect(leerLimitePedido({ maxOrders: -1 })).toBeUndefined();
    expect(leerLimitePedido({ maxOrders: 51 })).toBeUndefined();
    expect(leerLimitePedido({ maxOrders: 2.5 })).toBeUndefined();
    expect(leerLimitePedido({ maxOrders: '10' })).toBeUndefined();
    expect(leerLimitePedido({ maxOrders: NaN })).toBeUndefined();
    expect(leerLimitePedido({ maxOrders: null })).toBeUndefined();
  });

  it('la guarda vieja `body?.maxOrders &&` habría perdido el 0', () => {
    // Documenta exactamente el defecto: `0` es falsy.
    const body = { maxOrders: 0 };
    expect(Boolean(body.maxOrders)).toBe(false); // ← por acá se escapaba
    expect(leerLimitePedido(body)).toBe(TODOS); // ← ahora no
  });
});

describe('limiteEfectivo', () => {
  it('lo pedido gana siempre, incluso TODOS con testMode', () => {
    expect(limiteEfectivo(0, true)).toBe(0);
    expect(limiteEfectivo(5, true)).toBe(5);
    expect(limiteEfectivo(5, false)).toBe(5);
  });

  it('testMode sin límite explícito sigue siendo 1 (comportamiento histórico)', () => {
    expect(limiteEfectivo(undefined, true)).toBe(1);
  });

  it('sin nada pedido y sin testMode → sin override', () => {
    expect(limiteEfectivo(undefined, false)).toBeUndefined();
  });
});

describe('hayOverride', () => {
  it('0 SÍ es un override — es el centinela de "sin tope"', () => {
    expect(hayOverride(0)).toBe(true);
  });
  it('undefined no lo es', () => {
    expect(hayOverride(undefined)).toBe(false);
  });
  it('un número normal lo es', () => {
    expect(hayOverride(10)).toBe(true);
  });
});

describe('etiquetaDeLimite', () => {
  it('0 se lee "todos los pedidos", nunca "0 pedidos"', () => {
    expect(etiquetaDeLimite(0)).toBe('todos los pedidos');
    expect(etiquetaDeLimite(undefined)).toBe('todos los pedidos');
  });
  it('singular y plural', () => {
    expect(etiquetaDeLimite(1)).toBe('1 pedido');
    expect(etiquetaDeLimite(7)).toBe('7 pedidos');
  });
});
