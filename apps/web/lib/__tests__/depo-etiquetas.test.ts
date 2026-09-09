import { describe, it, expect } from 'vitest';
import { resumirDeposito, pct, type EtiquetaDeposito } from '../depo-etiquetas';

/**
 * Etiquetas del depósito distribuidas por cliente.
 *
 * Lo que fijan estos tests no es el conteo (eso es un for): es el ORDEN y el
 * criterio de qué fila existe. Una fila en cero, o el cliente equivocado
 * arriba, hacen que el operador lea mal la pantalla.
 */

const eti = (o: Partial<EtiquetaDeposito> = {}): EtiquetaDeposito => ({
  tenantId: 't1',
  tenantName: 'Kinevia',
  esDeposito: true,
  ...o,
});

describe('agrupación por cliente', () => {
  it('cuenta cada cliente por separado y no los mezcla', () => {
    const r = resumirDeposito([
      eti({ tenantId: 'a', tenantName: 'Kinevia' }),
      eti({ tenantId: 'a', tenantName: 'Kinevia' }),
      eti({ tenantId: 'b', tenantName: 'Nordika' }),
    ]);
    expect(r.clientes.find((c) => c.tenantId === 'a')!.total).toBe(2);
    expect(r.clientes.find((c) => c.tenantId === 'b')!.total).toBe(1);
  });

  it('el total es la suma exacta de las filas', () => {
    const r = resumirDeposito([
      eti({ tenantId: 'a' }),
      eti({ tenantId: 'b' }),
      eti({ tenantId: 'c' }),
      eti({ tenantId: 'c' }),
    ]);
    expect(r.total).toBe(r.clientes.reduce((n, c) => n + c.total, 0));
    expect(r.total).toBe(4);
  });

  it('sin etiquetas devuelve vacío y cero, no explota', () => {
    const r = resumirDeposito([]);
    expect(r.clientes).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('🔴 un cliente sin etiquetas en el rango NO aparece como fila en cero', () => {
    // Una fila en cero se lee como "esta tienda falló", y no falló: no despachó.
    const r = resumirDeposito([eti({ tenantId: 'a', tenantName: 'Kinevia' })]);
    expect(r.clientes).toHaveLength(1);
    expect(r.clientes[0].tenantId).toBe('a');
  });

  it('conserva el nombre de la primera aparición del cliente', () => {
    const r = resumirDeposito([eti({ tenantId: 'a', tenantName: 'Kinevia' }), eti({ tenantId: 'a', tenantName: 'Kinevia' })]);
    expect(r.clientes[0].tenantName).toBe('Kinevia');
  });
});

describe('orden de las filas', () => {
  it('🔴 las tiendas del depósito van primero, aunque tengan menos volumen', () => {
    const r = resumirDeposito([
      ...Array.from({ length: 5 }, () => eti({ tenantId: 'x', tenantName: 'Ajena', esDeposito: false })),
      eti({ tenantId: 'd', tenantName: 'Del depósito', esDeposito: true }),
    ]);
    expect(r.clientes[0].tenantId).toBe('d');
    expect(r.clientes[0].total).toBe(1);
  });

  it('dentro del mismo bloque manda el volumen, y con empate el nombre', () => {
    const r = resumirDeposito([
      eti({ tenantId: 'b', tenantName: 'Beta' }),
      eti({ tenantId: 'a', tenantName: 'Alfa' }),
      eti({ tenantId: 'c', tenantName: 'Gamma' }),
      eti({ tenantId: 'c', tenantName: 'Gamma' }),
    ]);
    expect(r.clientes.map((c) => c.tenantName)).toEqual(['Gamma', 'Alfa', 'Beta']);
  });

  it('el orden es estable: dos corridas con la misma entrada dan lo mismo', () => {
    const entrada = [
      eti({ tenantId: 'a', tenantName: 'Alfa' }),
      eti({ tenantId: 'b', tenantName: 'Beta' }),
      eti({ tenantId: 'c', tenantName: 'Gamma' }),
    ];
    expect(resumirDeposito(entrada).clientes.map((c) => c.tenantId))
      .toEqual(resumirDeposito(entrada).clientes.map((c) => c.tenantId));
  });
});

describe('pct', () => {
  it('redondea a entero', () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(2, 3)).toBe(67);
  });

  it('🔴 con total 0 devuelve 0, no NaN ni Infinity', () => {
    expect(pct(0, 0)).toBe(0);
    expect(pct(5, 0)).toBe(0);
    expect(Number.isNaN(pct(0, 0))).toBe(false);
  });
});
