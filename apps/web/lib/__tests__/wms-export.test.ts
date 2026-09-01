/**
 * Tests del armado del payload de export al WMS (lib/wms-export.ts).
 *
 * Correr:  cd apps/web && ../../node_modules/.bin/vitest run
 *
 * Lo que tiene que quedar clavado:
 *   - el shape de cada pedido es EXACTAMENTE el que consume el RPC
 *     `importar_tanda` de DEPO (nombres de campos incluidos: cualquier renombre
 *     silencioso rompe la importación del otro lado),
 *   - los labels sin ítems van a "sin_items" y NUNCA a la tanda importable,
 *   - el día es el LOCAL uruguayo (UTC-3), no el UTC — si esto se rompe, los
 *     envíos de después de las 21:00 UY se van al día siguiente.
 */
import { describe, it, expect } from 'vitest';
import {
  buildWmsExportPayload,
  parseYmd,
  toDepoItems,
  ordenarPila,
  parseZona,
  uyDayRange,
  uyToday,
  type WmsExportLabelRow,
} from '../wms-export';

function label(over: Partial<WmsExportLabelRow> = {}): WmsExportLabelRow {
  return {
    id: 'lbl_1',
    shopifyOrderName: '#1042',
    dacGuia: 'AB123456789',
    customerName: 'Juan Pérez',
    deliveryAddress: 'Av. Italia 1234 apto 5',
    city: 'Montevideo',
    department: 'Montevideo',
    createdAt: new Date('2026-09-01T15:00:00.000Z'),
    packSeq: null,
    printedAt: null,
    items: [{ sku: 'REM-001', title: 'Remera', quantity: 2 }],
    ...over,
  };
}

describe('shape del pedido — contrato importar_tanda', () => {
  it('tiene exactamente las claves del contrato, sin sobrantes', () => {
    const { pedidos } = buildWmsExportPayload([label()], { fecha: '2026-09-01', cliente: 'Alba Textil' });

    expect(pedidos).toHaveLength(1);
    // Las 7 del RPC + las 3 informativas que el consumidor declara opcionales
    // (departamento, reparto_propio, printedAt). Ninguna más: cualquier clave
    // nueva acá se está mandando a DEPO sin que nadie la haya pedido.
    expect(Object.keys(pedidos[0]).sort()).toEqual(
      [
        'ciudad', 'cliente', 'destinatario', 'direccion', 'external_ref', 'guia', 'items',
        'departamento', 'reparto_propio', 'printedAt',
      ].sort(),
    );
    expect(Object.keys(pedidos[0].items[0]).sort()).toEqual(['qty', 'sku']);
  });

  it('mapea Label → pedido con los valores en el campo correcto', () => {
    const { pedidos } = buildWmsExportPayload([label()], { fecha: '2026-09-01', cliente: 'Alba Textil' });

    expect(pedidos[0]).toEqual({
      cliente: 'Alba Textil',
      external_ref: '#1042',
      guia: 'AB123456789',
      destinatario: 'Juan Pérez',
      direccion: 'Av. Italia 1234 apto 5',
      ciudad: 'Montevideo',
      items: [{ sku: 'REM-001', qty: 2 }],
      departamento: 'Montevideo',
      reparto_propio: false,
      printedAt: null,
    });
  });

  it('external_ref es el nombre del pedido de Shopify, no el id interno', () => {
    const { pedidos } = buildWmsExportPayload([label({ id: 'cmz9abc', shopifyOrderName: '#2001' })], {
      fecha: '2026-09-01',
      cliente: 'T',
    });
    expect(pedidos[0].external_ref).toBe('#2001');
  });

  it('guia null (etiqueta sin guía) se serializa como null, no como ""', () => {
    const { pedidos } = buildWmsExportPayload([label({ dacGuia: null })], { fecha: '2026-09-01', cliente: 'T' });
    expect(pedidos[0].guia).toBeNull();
  });

  it('respeta el orden de entrada (ese orden es la pila de impresión)', () => {
    const rows = [
      label({ id: 'a', shopifyOrderName: '#1' }),
      label({ id: 'b', shopifyOrderName: '#2' }),
      label({ id: 'c', shopifyOrderName: '#3' }),
    ];
    const { pedidos } = buildWmsExportPayload(rows, { fecha: '2026-09-01', cliente: 'T' });
    expect(pedidos.map((p) => p.external_ref)).toEqual(['#1', '#2', '#3']);
  });

  it('normaliza saltos de línea y espacios de la dirección', () => {
    const { pedidos } = buildWmsExportPayload([label({ deliveryAddress: '  Av. Italia\n1234   apto 5 ' })], {
      fecha: '2026-09-01',
      cliente: 'T',
    });
    expect(pedidos[0].direccion).toBe('Av. Italia 1234 apto 5');
  });
});

describe('items', () => {
  it('cae al título cuando el ítem no tiene sku (DEPO lo mapea como alias)', () => {
    expect(toDepoItems([{ sku: null, title: 'Faja Reductora', quantity: 1 }])).toEqual([
      { sku: 'Faja Reductora', qty: 1 },
    ]);
  });

  it('prefiere el sku cuando está presente', () => {
    expect(toDepoItems([{ sku: 'FAJ-01', title: 'Faja Reductora', quantity: 1 }])).toEqual([
      { sku: 'FAJ-01', qty: 1 },
    ]);
  });

  it('suma las líneas repetidas del mismo sku conservando el orden de aparición', () => {
    expect(
      toDepoItems([
        { sku: 'X', title: 'A', quantity: 2 },
        { sku: 'Y', title: 'B', quantity: 1 },
        { sku: 'X', title: 'A', quantity: 3 },
      ]),
    ).toEqual([
      { sku: 'X', qty: 5 },
      { sku: 'Y', qty: 1 },
    ]);
  });

  it('agrupa por título cuando ninguno tiene sku', () => {
    expect(
      toDepoItems([
        { sku: null, title: 'Faja', quantity: 1 },
        { sku: '', title: 'Faja', quantity: 2 },
      ]),
    ).toEqual([{ sku: 'Faja', qty: 3 }]);
  });

  it('qty inválida cae a 1 y nunca a 0', () => {
    expect(toDepoItems([{ sku: 'X', title: 'A', quantity: 0 }])[0].qty).toBe(1);
    expect(toDepoItems([{ sku: 'X', title: 'A', quantity: -3 }])[0].qty).toBe(1);
    expect(toDepoItems([{ sku: 'X', title: 'A', quantity: Number.NaN }])[0].qty).toBe(1);
    expect(toDepoItems([{ sku: 'X', title: 'A', quantity: 2.7 }])[0].qty).toBe(2);
  });

  it('descarta el ítem sin sku ni título', () => {
    expect(toDepoItems([{ sku: '', title: '   ', quantity: 1 }])).toEqual([]);
  });
});

describe('sin_items — los históricos no van a la tanda', () => {
  it('separa los labels sin ítems y no los mezcla con los pedidos', () => {
    const payload = buildWmsExportPayload(
      [
        label({ id: 'a', shopifyOrderName: '#1' }),
        label({ id: 'b', shopifyOrderName: '#2', items: [] }),
        label({ id: 'c', shopifyOrderName: '#3' }),
      ],
      { fecha: '2026-09-01', cliente: 'T' },
    );

    expect(payload.pedidos.map((p) => p.external_ref)).toEqual(['#1', '#3']);
    expect(payload.sin_items.map((p) => p.external_ref)).toEqual(['#2']);
  });

  it('un label cuyos ítems se descartan todos también cae en sin_items', () => {
    const payload = buildWmsExportPayload([label({ items: [{ sku: '', title: '  ', quantity: 1 }] })], {
      fecha: '2026-09-01',
      cliente: 'T',
    });
    expect(payload.pedidos).toHaveLength(0);
    expect(payload.sin_items).toHaveLength(1);
  });

  it('los de sin_items conservan el mismo shape (para cargarlos a mano)', () => {
    const payload = buildWmsExportPayload([label({ items: [] })], { fecha: '2026-09-01', cliente: 'T' });
    expect(payload.sin_items[0]).toEqual({
      cliente: 'T',
      external_ref: '#1042',
      guia: 'AB123456789',
      destinatario: 'Juan Pérez',
      direccion: 'Av. Italia 1234 apto 5',
      ciudad: 'Montevideo',
      items: [],
      departamento: 'Montevideo',
      reparto_propio: false,
      printedAt: null,
    });
  });

  it('lista vacía devuelve las dos listas vacías, no null', () => {
    const payload = buildWmsExportPayload([], { fecha: '2026-09-01', cliente: 'T' });
    expect(payload).toEqual({
      fecha: '2026-09-01',
      cliente: 'T',
      zona: 'todas',
      pedidos: [],
      sin_items: [],
    });
  });
});

describe('día local uruguayo', () => {
  it('el rango arranca a las 03:00 UTC y dura 24 h', () => {
    const r = uyDayRange('2026-09-01');
    expect(r?.gte.toISOString()).toBe('2026-09-01T03:00:00.000Z');
    expect(r?.lt.toISOString()).toBe('2026-09-02T03:00:00.000Z');
  });

  it('incluye un envío de las 22:30 UY (= 01:30 UTC del día siguiente)', () => {
    const r = uyDayRange('2026-09-01')!;
    const envio = new Date('2026-09-02T01:30:00.000Z'); // 22:30 del 1/9 en UY
    expect(envio >= r.gte && envio < r.lt).toBe(true);
  });

  it('excluye un envío de las 23:30 UY del día ANTERIOR', () => {
    const r = uyDayRange('2026-09-01')!;
    const envio = new Date('2026-09-01T02:30:00.000Z'); // 23:30 del 31/8 en UY
    expect(envio >= r.gte && envio < r.lt).toBe(false);
  });

  it('cruza fin de mes sin romperse', () => {
    const r = uyDayRange('2026-08-31');
    expect(r?.gte.toISOString()).toBe('2026-08-31T03:00:00.000Z');
    expect(r?.lt.toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });

  it('uyToday devuelve el día UY, no el UTC, cerca de medianoche', () => {
    expect(uyToday(new Date('2026-09-02T01:30:00.000Z'))).toBe('2026-09-01');
    expect(uyToday(new Date('2026-09-01T03:00:00.000Z'))).toBe('2026-09-01');
    expect(uyToday(new Date('2026-09-01T02:59:59.000Z'))).toBe('2026-08-31');
  });

  describe('fechas inválidas se rechazan (la ruta devuelve 400)', () => {
    it.each(['', '2026-9-1', '01-09-2026', '2026-13-01', '2026-02-31', 'hoy', '2026-09-01T00:00:00Z'])(
      '%p',
      (bad) => {
        expect(parseYmd(bad)).toBeNull();
        expect(uyDayRange(bad)).toBeNull();
      },
    );

    it('null y undefined también', () => {
      expect(parseYmd(null)).toBeNull();
      expect(parseYmd(undefined)).toBeNull();
    });

    it('un bisiesto válido se acepta', () => {
      expect(parseYmd('2028-02-29')).toEqual({ y: 2028, m: 2, d: 29 });
    });
  });
});

describe('orden de la pila física — packSeq asc nulls last, createdAt asc', () => {
  const t = (iso: string) => new Date(iso);

  it('ordena por packSeq y manda las nunca impresas AL FINAL', () => {
    const payload = buildWmsExportPayload(
      [
        label({ shopifyOrderName: '#sin-b', packSeq: null, createdAt: t('2026-09-01T18:00:00Z') }),
        label({ shopifyOrderName: '#p2', packSeq: 2, createdAt: t('2026-09-01T10:00:00Z') }),
        label({ shopifyOrderName: '#sin-a', packSeq: null, createdAt: t('2026-09-01T09:00:00Z') }),
        label({ shopifyOrderName: '#p1', packSeq: 1, createdAt: t('2026-09-01T20:00:00Z') }),
      ],
      { fecha: '2026-09-01', cliente: 'T' },
    );

    // #p1 va primero AUNQUE se haya creado último: la pila manda sobre la hora.
    expect(payload.pedidos.map((p) => p.external_ref)).toEqual([
      '#p1',
      '#p2',
      '#sin-a',
      '#sin-b',
    ]);
  });

  it('ordenarPila no muta el array de entrada', () => {
    const rows = [label({ packSeq: 2 }), label({ packSeq: 1 })];
    const antes = rows.map((r) => r.packSeq);
    ordenarPila(rows);
    expect(rows.map((r) => r.packSeq)).toEqual(antes);
  });

  it('con packSeq empatado (no debería pasar) desempata por createdAt', () => {
    const out = ordenarPila([
      label({ id: 'b', packSeq: 1, createdAt: t('2026-09-01T12:00:00Z') }),
      label({ id: 'a', packSeq: 1, createdAt: t('2026-09-01T11:00:00Z') }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('departamento, reparto_propio y printedAt', () => {
  it('normaliza el departamento sucio de prod', () => {
    const { pedidos } = buildWmsExportPayload(
      [label({ department: 'Paysandú' }), label({ shopifyOrderName: '#2', department: 'Maldonado Department' })],
      { fecha: '2026-09-01', cliente: 'T' },
    );
    expect(pedidos.map((p) => p.departamento)).toEqual(['Paysandu', 'Maldonado']);
  });

  it('un departamento que no se reconoce sale como null, no como texto crudo', () => {
    const { pedidos } = buildWmsExportPayload([label({ department: 'Valencia' })], {
      fecha: '2026-09-01',
      cliente: 'T',
    });
    expect(pedidos[0].departamento).toBeNull();
    expect(pedidos[0].reparto_propio).toBe(false);
  });

  it('marca reparto_propio por departamento y por guía LF-', () => {
    const { pedidos } = buildWmsExportPayload(
      [
        label({ shopifyOrderName: '#mal', department: 'Maldonado' }),
        label({ shopifyOrderName: '#lf', department: 'Rocha', dacGuia: 'LF-000001' }),
        label({ shopifyOrderName: '#dac', department: 'Rocha' }),
      ],
      { fecha: '2026-09-01', cliente: 'T' },
    );
    const byRef = new Map(pedidos.map((p) => [p.external_ref, p.reparto_propio]));
    expect(byRef.get('#mal')).toBe(true);
    expect(byRef.get('#lf')).toBe(true);
    expect(byRef.get('#dac')).toBe(false);
  });

  it('printedAt sale en ISO 8601 o null', () => {
    const { pedidos } = buildWmsExportPayload(
      [
        label({ shopifyOrderName: '#a', printedAt: new Date('2026-09-01T13:45:00.000Z') }),
        label({ shopifyOrderName: '#b', printedAt: null }),
      ],
      { fecha: '2026-09-01', cliente: 'T' },
    );
    const byRef = new Map(pedidos.map((p) => [p.external_ref, p.printedAt]));
    expect(byRef.get('#a')).toBe('2026-09-01T13:45:00.000Z');
    expect(byRef.get('#b')).toBeNull();
  });
});

describe('zona — partir la tanda en reparto propio / resto', () => {
  const dia = () => [
    label({ shopifyOrderName: '#mal', department: 'Maldonado' }),
    label({ shopifyOrderName: '#lf', department: 'Rocha', dacGuia: 'LF-1' }),
    label({ shopifyOrderName: '#mvd', department: 'Montevideo' }),
  ];

  it('todas (default) no filtra nada', () => {
    const p = buildWmsExportPayload(dia(), { fecha: '2026-09-01', cliente: 'T' });
    expect(p.zona).toBe('todas');
    expect(p.pedidos).toHaveLength(3);
  });

  it('maldonado deja sólo lo de reparto propio', () => {
    const p = buildWmsExportPayload(dia(), { fecha: '2026-09-01', cliente: 'T', zona: 'maldonado' });
    expect(p.pedidos.map((x) => x.external_ref).sort()).toEqual(['#lf', '#mal']);
    expect(p.pedidos.every((x) => x.reparto_propio)).toBe(true);
  });

  it('resto deja sólo lo que se va por DAC', () => {
    const p = buildWmsExportPayload(dia(), { fecha: '2026-09-01', cliente: 'T', zona: 'resto' });
    expect(p.pedidos.map((x) => x.external_ref)).toEqual(['#mvd']);
  });

  it('las dos zonas son complementarias: ninguna etiqueta se pierde ni se duplica', () => {
    const rows = dia();
    const a = buildWmsExportPayload(rows, { fecha: '2026-09-01', cliente: 'T', zona: 'maldonado' });
    const b = buildWmsExportPayload(rows, { fecha: '2026-09-01', cliente: 'T', zona: 'resto' });
    const refs = [...a.pedidos, ...b.pedidos].map((x) => x.external_ref).sort();
    expect(refs).toEqual(['#lf', '#mal', '#mvd']);
  });

  it('el filtro de zona también parte sin_items', () => {
    const p = buildWmsExportPayload(
      [
        label({ shopifyOrderName: '#mal', department: 'Maldonado', items: [] }),
        label({ shopifyOrderName: '#mvd', department: 'Montevideo', items: [] }),
      ],
      { fecha: '2026-09-01', cliente: 'T', zona: 'maldonado' },
    );
    expect(p.pedidos).toHaveLength(0);
    expect(p.sin_items.map((x) => x.external_ref)).toEqual(['#mal']);
  });

  describe('parseZona', () => {
    it('acepta las tres zonas, con mayúsculas y espacios', () => {
      expect(parseZona('maldonado')).toBe('maldonado');
      expect(parseZona(' RESTO ')).toBe('resto');
      expect(parseZona('Todas')).toBe('todas');
    });

    it('ausente o vacía cae a todas', () => {
      expect(parseZona(null)).toBe('todas');
      expect(parseZona(undefined)).toBe('todas');
      expect(parseZona('')).toBe('todas');
    });

    it('una zona desconocida es null (la ruta devuelve 400, no exporta de más)', () => {
      expect(parseZona('canelones')).toBeNull();
      expect(parseZona('all')).toBeNull();
      expect(parseZona('maldonado ')).toBe('maldonado');
      expect(parseZona('mal')).toBeNull();
    });
  });
});
