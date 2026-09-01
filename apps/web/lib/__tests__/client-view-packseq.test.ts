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
 *   - el índice es 1-based, deduplicado y respeta el orden del array,
 *   - todo el estampado de packSeq va en UNA transacción: media pila ordenada
 *     es peor que ninguna.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMany = vi.fn();
const $transaction = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    label: {
      get updateMany() {
        return updateMany;
      },
    },
    get $transaction() {
      return $transaction;
    },
  },
}));

import { markClientViewLabelsPrinted } from '../client-view';

const TENANTS = ['t1'];

beforeEach(() => {
  updateMany.mockReset();
  $transaction.mockReset();
  // updateMany devuelve un "op" identificable para poder inspeccionar el array
  // que se le pasa a $transaction sin depender del cliente real de Prisma.
  updateMany.mockImplementation((args: unknown) => ({ __op: args }));
  $transaction.mockResolvedValue([]);
});

/** Los args de las llamadas a updateMany que traen `data.packSeq`. */
function packSeqCalls() {
  return updateMany.mock.calls
    .map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> })
    .filter((a) => 'packSeq' in a.data);
}

describe('markClientViewLabelsPrinted', () => {
  it('no toca la base con lista de ids vacía o sin tenants', async () => {
    await markClientViewLabelsPrinted([], TENANTS, { stampPackSeq: true });
    await markClientViewLabelsPrinted(['a'], [], { stampPackSeq: true });
    expect(updateMany).not.toHaveBeenCalled();
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
    expect($transaction).not.toHaveBeenCalled();
  });

  it('con stampPackSeq estampa index+1 en el orden del array', async () => {
    await markClientViewLabelsPrinted(['c', 'a', 'b'], TENANTS, { stampPackSeq: true });

    const calls = packSeqCalls();
    expect(calls.map((c) => [c.where.id, c.data.packSeq])).toEqual([
      ['c', 1],
      ['a', 2],
      ['b', 3],
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
    await markClientViewLabelsPrinted(['a', 'b'], ['t1', 't2'], { stampPackSeq: true });
    for (const c of packSeqCalls()) {
      expect(c.where.tenantId).toEqual({ in: ['t1', 't2'] });
    }
  });

  it('deduplica ids repetidos sin dejar huecos en la numeración', async () => {
    await markClientViewLabelsPrinted(['a', 'b', 'a', 'c'], TENANTS, { stampPackSeq: true });

    const calls = packSeqCalls();
    expect(calls.map((c) => [c.where.id, c.data.packSeq])).toEqual([
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
});
