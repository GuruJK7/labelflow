/**
 * Tests de la captura de ítems del pedido (jobs/label-items.ts).
 *
 * Lo que tiene que quedar clavado:
 *   - el snapshot es fiel: una fila por line_item, sin agrupar,
 *   - los bordes de cantidad NUNCA producen 0 (un 0 en el WMS = no se empaca),
 *   - la escritura es "reemplazar", no "agregar": un reintento del mismo pedido
 *     no puede duplicar unidades,
 *   - NUNCA tira: la guía de DAC ya está emitida cuando esto corre.
 *
 * Todo el I/O está mockeado: sin DB, sin red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    $transaction: vi.fn().mockResolvedValue([]),
    labelItem: { deleteMany: vi.fn(), createMany: vi.fn() },
  },
}));

import { buildLabelItems, persistLabelItems } from '../jobs/label-items';
import { db } from '../db';

const li = (title: string | null, quantity: number, sku?: string | null) =>
  ({ title, quantity, price: '0.00', product_id: null, ...(sku !== undefined ? { sku } : {}) }) as never;

describe('buildLabelItems — snapshot fiel del pedido', () => {
  it('mapea title, sku y quantity uno a uno', () => {
    expect(
      buildLabelItems({ line_items: [li('Faja Reductora', 2, 'FAJ-01'), li('Plantillas', 1, 'PLA-09')] }),
    ).toEqual([
      { sku: 'FAJ-01', title: 'Faja Reductora', quantity: 2 },
      { sku: 'PLA-09', title: 'Plantillas', quantity: 1 },
    ]);
  });

  it('NO agrupa líneas repetidas del mismo sku (el snapshot es fiel; DEPO suma)', () => {
    expect(buildLabelItems({ line_items: [li('A', 2, 'X'), li('A', 3, 'X')] })).toEqual([
      { sku: 'X', title: 'A', quantity: 2 },
      { sku: 'X', title: 'A', quantity: 3 },
    ]);
  });

  it('sku ausente o vacío queda en null (el export cae al título)', () => {
    expect(buildLabelItems({ line_items: [li('Sin sku', 1), li('Vacío', 1, ''), li('Blancos', 1, '   ')] })).toEqual([
      { sku: null, title: 'Sin sku', quantity: 1 },
      { sku: null, title: 'Vacío', quantity: 1 },
      { sku: null, title: 'Blancos', quantity: 1 },
    ]);
  });

  it('title vacío con sku presente usa el sku como título (title es NOT NULL)', () => {
    expect(buildLabelItems({ line_items: [li('', 1, 'SOLO-SKU'), li(null, 2, 'OTRO')] })).toEqual([
      { sku: 'SOLO-SKU', title: 'SOLO-SKU', quantity: 1 },
      { sku: 'OTRO', title: 'OTRO', quantity: 2 },
    ]);
  });

  it('descarta el ítem que no tiene ni título ni sku', () => {
    expect(buildLabelItems({ line_items: [li('', 1), li(null, 1, null), li('  ', 3)] })).toEqual([]);
  });

  it('normaliza espacios, saltos de línea y tabs', () => {
    expect(buildLabelItems({ line_items: [li('  Remera\n  Azul\t ', 1, ' REM-1 ')] })).toEqual([
      { sku: 'REM-1', title: 'Remera Azul', quantity: 1 },
    ]);
  });

  describe('cantidades — nunca 0, nunca negativas, nunca decimales', () => {
    it.each([
      [0, 1],
      [-4, 1],
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 1],
      [2.9, 2],
      [7, 7],
    ])('quantity %p → %p', (input, expected) => {
      expect(buildLabelItems({ line_items: [li('A', input as number, 'X')] })[0].quantity).toBe(expected);
    });

    it('quantity no numérica cae a 1', () => {
      expect(buildLabelItems({ line_items: [li('A', 'dos' as never, 'X')] })[0].quantity).toBe(1);
    });
  });

  describe('entradas degeneradas devuelven lista vacía', () => {
    it.each([
      ['line_items vacío', { line_items: [] }],
      ['line_items null', { line_items: null as never }],
      ['line_items undefined', { line_items: undefined as never }],
      ['line_items no es array', { line_items: 'nope' as never }],
      ['order null', null],
      ['order undefined', undefined],
    ])('%s', (_label, order) => {
      expect(buildLabelItems(order as never)).toEqual([]);
    });
  });
});

describe('persistLabelItems — escritura', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.$transaction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('escribe delete + createMany en UNA transacción (reemplazo atómico)', async () => {
    const n = await persistLabelItems('lbl_1', { line_items: [li('A', 2, 'X'), li('B', 1, 'Y')] });

    expect(n).toBe(2);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.labelItem.deleteMany).toHaveBeenCalledWith({ where: { labelId: 'lbl_1' } });
    expect(db.labelItem.createMany).toHaveBeenCalledWith({
      data: [
        { labelId: 'lbl_1', sku: 'X', title: 'A', quantity: 2 },
        { labelId: 'lbl_1', sku: 'Y', title: 'B', quantity: 1 },
      ],
    });
    // El delete tiene que ir ANTES del create dentro del array de la transacción:
    // al revés duplicaría en cada reintento.
    const ops = (db.$transaction as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ops).toHaveLength(2);
  });

  it('reintento del mismo pedido no acumula: siempre borra antes de escribir', async () => {
    await persistLabelItems('lbl_1', { line_items: [li('A', 2, 'X')] });
    await persistLabelItems('lbl_1', { line_items: [li('A', 2, 'X')] });

    expect(db.labelItem.deleteMany).toHaveBeenCalledTimes(2);
    expect(db.labelItem.createMany).toHaveBeenCalledTimes(2);
  });

  it('sin ítems no toca la base (no borra el snapshot anterior)', async () => {
    const n = await persistLabelItems('lbl_1', { line_items: [] });

    expect(n).toBe(0);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.labelItem.deleteMany).not.toHaveBeenCalled();
  });

  it('si la DB falla NO tira, devuelve 0 y loguea un warn', async () => {
    (db.$transaction as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('relation "LabelItem" does not exist'),
    );
    const log = { warn: vi.fn() };

    const n = await persistLabelItems('lbl_1', { line_items: [li('A', 1, 'X')] }, log);

    expect(n).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      'label-items',
      expect.stringContaining('does not exist'),
      { labelId: 'lbl_1' },
    );
  });

  it('sin logger tampoco tira cuando la DB falla', async () => {
    (db.$transaction as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await expect(persistLabelItems('lbl_1', { line_items: [li('A', 1, 'X')] })).resolves.toBe(0);
  });
});
