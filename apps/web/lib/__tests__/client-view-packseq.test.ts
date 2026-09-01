/**
 * Tests de markClientViewLabelsPrinted() — el estampado de printedAt y del
 * orden de la pila física (packSeq).
 *
 * Correr:  npx vitest run --root apps/web
 *
 * Prisma va mockeado: lo que se verifica es la FORMA de las escrituras, que es
 * donde están los errores caros:
 *   - printedAt sólo pisa nulls (la primera impresión nunca se sobreescribe),
 *   - packSeq SOLO se escribe si el caller lo pide (el endpoint de PDF único
 *     no puede estampar un "1" en cada etiqueta que el cliente baje suelta),
 *   - packSeq SÍ pisa (reimprimir arma una pila nueva) y por eso su update NO
 *     lleva el filtro printedAt: null,
 *   - la numeración SIGUE DESDE EL MÁXIMO DEL DÍA, no desde 1 en cada
 *     impresión: imprimir por grupos da 1..8 y después 9..60, y una
 *     reimpresión parcial se va al final (= dónde queda el papel de verdad),
 *   - cada (tenant, día local UY) numera aparte,
 *   - el índice respeta el orden del array y está deduplicado,
 *   - todo el estampado de packSeq va en UNA transacción: media pila ordenada
 *     es peor que ninguna.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMany = vi.fn();
const findMany = vi.fn();
const aggregate = vi.fn();
const $transaction = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    label: {
      get updateMany() {
        return updateMany;
      },
      get findMany() {
        return findMany;
      },
      get aggregate() {
        return aggregate;
      },
    },
    get $transaction() {
      return $transaction;
    },
  },
}));

import { markClientViewLabelsPrinted } from '../client-view';

const TENANTS = ['t1'];

/** 2026-09-01 12:00 UY (= 15:00 UTC). Día local uruguayo: 2026-09-01. */
const HOY = new Date('2026-09-01T15:00:00.000Z');
/** 00:00 UY del 2026-09-01, que es 03:00 UTC. Lo que espera el rango del día. */
const HOY_UY_00 = new Date('2026-09-01T03:00:00.000Z');

/**
 * Hace que findMany devuelva una fila por id pedido, todas del mismo tenant y
 * del mismo instante, y que aggregate devuelva `max` como máximo del día.
 */
function conBase(opts: { max?: number | null; createdAt?: Date; tenantId?: string } = {}) {
  const createdAt = opts.createdAt ?? HOY;
  const tenantId = opts.tenantId ?? 't1';
  findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.map((id) => ({ id, tenantId, createdAt })),
  );
  aggregate.mockResolvedValue({ _max: { packSeq: opts.max ?? null } });
}

beforeEach(() => {
  updateMany.mockReset();
  findMany.mockReset();
  aggregate.mockReset();
  $transaction.mockReset();
  // updateMany devuelve un "op" identificable para poder inspeccionar el array
  // que se le pasa a $transaction sin depender del cliente real de Prisma.
  updateMany.mockImplementation((args: unknown) => ({ __op: args }));
  $transaction.mockResolvedValue([]);
  conBase();
});

/** Los args de las llamadas a updateMany que traen `data.packSeq`. */
function packSeqCalls() {
  return updateMany.mock.calls
    .map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> })
    .filter((a) => 'packSeq' in a.data);
}

/** [id, packSeq] en el orden en que se emitieron los updates. */
function asignaciones() {
  return packSeqCalls().map((c) => [c.where.id, c.data.packSeq]);
}

describe('markClientViewLabelsPrinted', () => {
  it('no toca la base con lista de ids vacía o sin tenants', async () => {
    await markClientViewLabelsPrinted([], TENANTS, { stampPackSeq: true });
    await markClientViewLabelsPrinted(['a'], [], { stampPackSeq: true });
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('estampa printedAt sólo sobre nulls y NO estampa packSeq por default', async () => {
    await markClientViewLabelsPrinted(['a', 'b'], TENANTS);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const args = updateMany.mock.calls[0][0];
    expect(args.where).toEqual({
      id: { in: ['a', 'b'] },
      tenantId: { in: TENANTS },
      printedAt: null,
    });
    expect(args.data.printedAt).toBeInstanceOf(Date);
    expect(args.data).not.toHaveProperty('packSeq');
    // Sin stampPackSeq no se paga ni la lectura del día.
    expect(findMany).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('un día sin ningún packSeq arranca en 1, en el orden del array', async () => {
    await markClientViewLabelsPrinted(['c', 'a', 'b'], TENANTS, { stampPackSeq: true });

    expect(asignaciones()).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ]);
  });

  it('busca el máximo dentro del DÍA LOCAL URUGUAYO de la etiqueta, no del día UTC', async () => {
    // 02:00 UTC del 1/9 son las 23:00 UY del 31/8: el día es el 31, no el 1.
    conBase({ createdAt: new Date('2026-09-01T02:00:00.000Z') });
    await markClientViewLabelsPrinted(['a'], TENANTS, { stampPackSeq: true });

    expect(aggregate).toHaveBeenCalledTimes(1);
    const args = aggregate.mock.calls[0][0];
    expect(args._max).toEqual({ packSeq: true });
    expect(args.where.tenantId).toBe('t1');
    expect(args.where.createdAt.gte.toISOString()).toBe('2026-08-31T03:00:00.000Z');
    expect(args.where.createdAt.lt.toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });

  it('DOS GRUPOS: el segundo NO vuelve a arrancar en 1 (Maldonado 1..3, resto 4..6)', async () => {
    // Primera impresión: el grupo de Maldonado, con el día vacío.
    conBase({ max: null });
    await markClientViewLabelsPrinted(['m1', 'm2', 'm3'], TENANTS, { stampPackSeq: true });
    expect(asignaciones()).toEqual([
      ['m1', 1],
      ['m2', 2],
      ['m3', 3],
    ]);

    // Segunda impresión: el resto del día, con el máximo ya en 3.
    updateMany.mockClear();
    conBase({ max: 3 });
    await markClientViewLabelsPrinted(['r1', 'r2', 'r3'], TENANTS, { stampPackSeq: true });
    expect(asignaciones()).toEqual([
      ['r1', 4],
      ['r2', 5],
      ['r3', 6],
    ]);
  });

  it('REIMPRESIÓN PARCIAL: las reimpresas se van AL FINAL de la pila del día', async () => {
    // El día ya tiene 60 etiquetas numeradas; se reimprimen 2 del medio.
    conBase({ max: 60 });
    await markClientViewLabelsPrinted(['x12', 'x37'], TENANTS, { stampPackSeq: true });

    expect(asignaciones()).toEqual([
      ['x12', 61],
      ['x37', 62],
    ]);
  });

  it('cada (tenant, día) numera aparte: dos tiendas del mismo link no se pisan', async () => {
    findMany.mockResolvedValue([
      { id: 'a', tenantId: 't1', createdAt: HOY },
      { id: 'b', tenantId: 't2', createdAt: HOY },
      { id: 'c', tenantId: 't1', createdAt: HOY },
    ]);
    // t1 ya tiene 5 impresas hoy; t2 ninguna.
    aggregate.mockImplementation(async (args: { where: { tenantId: string } }) => ({
      _max: { packSeq: args.where.tenantId === 't1' ? 5 : null },
    }));

    await markClientViewLabelsPrinted(['a', 'b', 'c'], ['t1', 't2'], {
      stampPackSeq: true,
    });

    expect(asignaciones()).toEqual([
      ['a', 6],
      ['b', 1],
      ['c', 7],
    ]);
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it('un id fuera del allow-list no consume un número de la pila', async () => {
    // findMany sólo devuelve los que el allow-list deja pasar.
    findMany.mockResolvedValue([
      { id: 'a', tenantId: 't1', createdAt: HOY },
      { id: 'c', tenantId: 't1', createdAt: HOY },
    ]);

    await markClientViewLabelsPrinted(['a', 'ajeno', 'c'], TENANTS, {
      stampPackSeq: true,
    });

    expect(asignaciones()).toEqual([
      ['a', 1],
      ['c', 2],
    ]);
  });

  it('el update de packSeq NO filtra por printedAt: reimprimir pisa la pila vieja', async () => {
    await markClientViewLabelsPrinted(['a'], TENANTS, { stampPackSeq: true });

    const calls = packSeqCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ id: 'a', tenantId: { in: TENANTS } });
    expect(calls[0].where).not.toHaveProperty('printedAt');
  });

  it('sigue acotado al allow-list de tenants', async () => {
    conBase();
    await markClientViewLabelsPrinted(['a', 'b'], ['t1', 't2'], { stampPackSeq: true });
    for (const c of packSeqCalls()) {
      expect(c.where.tenantId).toEqual({ in: ['t1', 't2'] });
    }
    // La lectura previa también.
    expect(findMany.mock.calls[0][0].where.tenantId).toEqual({ in: ['t1', 't2'] });
  });

  it('deduplica ids repetidos sin dejar huecos en la numeración', async () => {
    await markClientViewLabelsPrinted(['a', 'b', 'a', 'c'], TENANTS, { stampPackSeq: true });

    expect(asignaciones()).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });

  it('manda todos los packSeq en UNA sola transacción', async () => {
    await markClientViewLabelsPrinted(['a', 'b', 'c'], TENANTS, { stampPackSeq: true });

    expect($transaction).toHaveBeenCalledTimes(1);
    const ops = $transaction.mock.calls[0][0];
    expect(Array.isArray(ops)).toBe(true);
    expect(ops).toHaveLength(3);
  });

  it('printedAt se sigue estampando aunque también se estampe packSeq', async () => {
    await markClientViewLabelsPrinted(['a'], TENANTS, { stampPackSeq: true });

    const printedCalls = updateMany.mock.calls
      .map((c) => c[0])
      .filter((a: { data: Record<string, unknown> }) => 'printedAt' in a.data);
    expect(printedCalls).toHaveLength(1);
    expect(printedCalls[0].where.printedAt).toBeNull();
  });

  it('si ninguna etiqueta resuelve, no abre transacción', async () => {
    findMany.mockResolvedValue([]);
    await markClientViewLabelsPrinted(['a'], TENANTS, { stampPackSeq: true });
    expect(aggregate).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});

// Referencia del rango esperado, para que un cambio de zona horaria rompa acá
// y no en producción.
describe('borde del día uruguayo', () => {
  it('00:00 UY del 2026-09-01 es 03:00 UTC', () => {
    expect(HOY_UY_00.toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });
});
