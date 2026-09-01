/**
 * Tests del read-through backfill de ítems del export al WMS
 * (lib/wms-items-backfill.ts).
 *
 * Correr:  cd apps/web && ../../node_modules/.bin/vitest run
 *
 * Lo que tiene que quedar clavado (todos son el bug real de hoy o su reverso):
 *   - una Label QUE YA TIENE ítems no genera ni un request a Shopify (el
 *     backfill es el camino excepcional, no el normal: si esto se rompe, cada
 *     export de 60 etiquetas pega 60 veces contra la Admin API),
 *   - una Label sin snapshot se completa desde Shopify Y queda persistida como
 *     LabelItem (sin la persistencia el export nunca deja de pagar el costo),
 *   - Shopify caído NO puede voltear el export: esa etiqueta cae a sin_items y
 *     el resto del payload sale igual — degradación, nunca excepción,
 *   - el fetch va EN LOTE y se parte en 250 (el `ids` de la Admin API no acepta
 *     más; sin el corte, un lote grande vuelve con un 400 y se pierde entero),
 *   - un tenant sin tienda conectada no rompe nada y no intenta nada.
 *
 * Prisma va mockeado: lo que importa acá es la FORMA de la escritura
 * (deleteMany + createMany por labelId en una transacción), que es la misma que
 * usa el worker en apps/worker/src/jobs/label-items.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const deleteMany = vi.fn();
const createMany = vi.fn();
const $transaction = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    labelItem: {
      get deleteMany() {
        return deleteMany;
      },
      get createMany() {
        return createMany;
      },
    },
    get $transaction() {
      return $transaction;
    },
  },
}));

// El token del tenant viaja cifrado con ENCRYPTION_KEY. Acá no interesa la
// criptografía (ya está testeada en su módulo), interesa que el backfill use el
// texto plano y que un token ilegible no explote.
vi.mock('@/lib/encryption', () => ({
  decryptIfPresent: (v: string | null | undefined) =>
    !v ? null : v === 'ILEGIBLE' ? null : v.replace(/^enc:/, ''),
}));

import {
  backfillMissingItems,
  applyBackfilledItems,
  buildLabelItems,
  chunk,
  SHOPIFY_IDS_BATCH,
  type BackfillLabelRow,
} from '../wms-items-backfill';
import { buildWmsExportPayload, type WmsExportLabelRow } from '../wms-export';

const CREDS = { shopifyStoreUrl: 'kinevia.myshopify.com', shopifyToken: 'enc:shpat_123' };

function row(over: Partial<BackfillLabelRow> = {}): BackfillLabelRow {
  return { id: 'lbl_1', shopifyOrderId: '5001', items: [], ...over };
}

/** Respuesta OK de orders.json con los pedidos pedidos. */
function shopifyOk(orders: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ orders }) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  deleteMany.mockReset().mockReturnValue({ __op: 'deleteMany' });
  createMany.mockReset().mockReturnValue({ __op: 'createMany' });
  $transaction.mockReset().mockResolvedValue([]);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('(a) camino normal — con snapshot no se toca Shopify', () => {
  it('una Label con ítems no dispara ningún fetch ni escritura', async () => {
    const res = await backfillMissingItems(
      [row({ items: [{ sku: 'REM-001', title: 'Remera', quantity: 2 }] })],
      CREDS,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
    expect(res.items.size).toBe(0);
    expect(res.intentadas).toBe(0);
    expect(res.skipped).toBe('nada-que-hacer');
  });

  it('con una mezcla, sólo pide los ids de las que NO tienen ítems', async () => {
    fetchMock.mockResolvedValue(
      shopifyOk([{ id: 5002, line_items: [{ sku: 'BUZ-9', title: 'Buzo', quantity: 1 }] }]),
    );

    await backfillMissingItems(
      [
        row({ id: 'a', shopifyOrderId: '5001', items: [{ sku: 'X', title: 'X', quantity: 1 }] }),
        row({ id: 'b', shopifyOrderId: '5002' }),
      ],
      CREDS,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('ids')).toBe('5002');
  });
});

describe('(b) backfill — completa desde Shopify y persiste', () => {
  it('devuelve los ítems y escribe LabelItem con la forma del worker', async () => {
    fetchMock.mockResolvedValue(
      shopifyOk([
        {
          id: 5001,
          line_items: [
            { sku: 'REM-001', title: 'Remera negra', quantity: 2 },
            { sku: '', title: 'Sticker', quantity: 1 },
          ],
        },
      ]),
    );

    const res = await backfillMissingItems([row()], CREDS);

    expect(res.recuperadas).toBe(1);
    expect(res.persistidas).toBe(1);
    expect(res.items.get('lbl_1')).toEqual([
      { sku: 'REM-001', title: 'Remera negra', quantity: 2 },
      { sku: null, title: 'Sticker', quantity: 1 },
    ]);

    // La escritura: deleteMany + createMany del MISMO labelId, en UNA
    // transacción. Reemplaza el set, no agrega — reintentar no duplica.
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0][0]).toHaveLength(2);
    expect(deleteMany).toHaveBeenCalledWith({ where: { labelId: 'lbl_1' } });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { labelId: 'lbl_1', sku: 'REM-001', title: 'Remera negra', quantity: 2 },
        { labelId: 'lbl_1', sku: null, title: 'Sticker', quantity: 1 },
      ],
    });
  });

  it('usa el token DESCIFRADO y la store del tenant en el request', async () => {
    fetchMock.mockResolvedValue(shopifyOk([]));
    await backfillMissingItems([row()], CREDS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://kinevia.myshopify.com/admin/api/2024-01/orders.json');
    expect(url).toContain('fields=id%2Cline_items');
    expect(url).toContain('status=any');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123');
  });

  it('si la escritura falla igual devuelve los ítems (best-effort)', async () => {
    fetchMock.mockResolvedValue(
      shopifyOk([{ id: 5001, line_items: [{ sku: 'A', title: 'A', quantity: 1 }] }]),
    );
    $transaction.mockRejectedValue(new Error('deadlock'));

    const res = await backfillMissingItems([row()], CREDS);

    expect(res.recuperadas).toBe(1);
    expect(res.persistidas).toBe(0);
    expect(res.items.get('lbl_1')).toHaveLength(1);
  });

  it('la etiqueta de reparto propio (guía LF-) también se completa', async () => {
    fetchMock.mockResolvedValue(
      shopifyOk([{ id: 7777, line_items: [{ sku: 'LF-1', title: 'Caja', quantity: 3 }] }]),
    );
    const res = await backfillMissingItems([row({ id: 'lf', shopifyOrderId: '7777' })], CREDS);
    expect(res.items.get('lf')).toEqual([{ sku: 'LF-1', title: 'Caja', quantity: 3 }]);
  });

  it('ignora las Labels con shopifyOrderId no numérico', async () => {
    const res = await backfillMissingItems([row({ shopifyOrderId: 'manual-abc' })], CREDS);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.skipped).toBe('nada-que-hacer');
  });
});

describe('(c) Shopify caído — degradación, nunca excepción', () => {
  it('un throw de fetch deja esa Label sin ítems y no propaga', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const res = await backfillMissingItems([row()], CREDS);

    expect(res.recuperadas).toBe(0);
    expect(res.items.size).toBe(0);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('un 429 (rate limit) tampoco rompe', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(backfillMissingItems([row()], CREDS)).resolves.toBeTruthy();
  });

  it('el resto del payload sale igual: la caída sólo agranda sin_items', async () => {
    fetchMock.mockRejectedValue(new Error('Shopify down'));

    const conItems: WmsExportLabelRow & { shopifyOrderId: string } = {
      id: 'ok',
      shopifyOrderId: '5001',
      shopifyOrderName: '#1001',
      dacGuia: 'AB1',
      customerName: 'Ana',
      deliveryAddress: 'Calle 1',
      city: 'Montevideo',
      department: 'Montevideo',
      createdAt: new Date('2026-09-01T15:00:00.000Z'),
      packSeq: 1,
      printedAt: null,
      items: [{ sku: 'REM-001', title: 'Remera', quantity: 1 }],
    };
    const sinItems = { ...conItems, id: 'roto', shopifyOrderId: '5002', shopifyOrderName: '#1002', dacGuia: 'AB2', packSeq: 2, items: [] };

    const rows = [conItems, sinItems];
    const res = await backfillMissingItems(rows, CREDS);
    const payload = buildWmsExportPayload(applyBackfilledItems(rows, res.items), {
      fecha: '2026-09-01',
      cliente: 'Kinevia',
    });

    expect(payload.pedidos.map((p) => p.external_ref)).toEqual(['#1001']);
    expect(payload.sin_items.map((p) => p.external_ref)).toEqual(['#1002']);
  });
});

describe('(d) lotes — el fetch se parte en 250', () => {
  it('251 Labels sin ítems generan 2 requests de 250 + 1', async () => {
    fetchMock.mockResolvedValue(shopifyOk([]));

    const rows = Array.from({ length: 251 }, (_, i) =>
      row({ id: `l${i}`, shopifyOrderId: String(9000 + i) }),
    );
    await backfillMissingItems(rows, CREDS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ids1 = new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('ids')!.split(',');
    const ids2 = new URL(fetchMock.mock.calls[1][0] as string).searchParams.get('ids')!.split(',');
    expect(ids1).toHaveLength(SHOPIFY_IDS_BATCH);
    expect(ids2).toHaveLength(1);
    // Ningún lote puede pasarse del máximo que acepta el parámetro `ids`.
    expect(Math.max(ids1.length, ids2.length)).toBeLessThanOrEqual(250);
  });

  it('un lote que falla no se lleva puesto al otro', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(
        shopifyOk([{ id: 9250, line_items: [{ sku: 'Z', title: 'Z', quantity: 1 }] }]),
      );

    const rows = Array.from({ length: 251 }, (_, i) =>
      row({ id: `l${i}`, shopifyOrderId: String(9000 + i) }),
    );
    const res = await backfillMissingItems(rows, CREDS);

    expect(res.recuperadas).toBe(1);
    expect(res.items.get('l250')).toEqual([{ sku: 'Z', title: 'Z', quantity: 1 }]);
  });

  it('ids duplicados (envío partido) se piden una sola vez', async () => {
    fetchMock.mockResolvedValue(
      shopifyOk([{ id: 5001, line_items: [{ sku: 'A', title: 'A', quantity: 1 }] }]),
    );
    const res = await backfillMissingItems(
      [row({ id: 'a', shopifyOrderId: '5001' }), row({ id: 'b', shopifyOrderId: '5001' })],
      CREDS,
    );
    expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get('ids')).toBe('5001');
    // Pero las DOS Labels se completan con ese pedido.
    expect(res.recuperadas).toBe(2);
  });

  it('los writes van en tandas y NINGUNA etiqueta se pierde en el camino', async () => {
    // Más que PERSIST_CONCURRENCY: es donde se rompería un chunk mal escrito.
    const n = 20;
    fetchMock.mockResolvedValue(
      shopifyOk(
        Array.from({ length: n }, (_, i) => ({
          id: 6000 + i,
          line_items: [{ sku: `S${i}`, title: `T${i}`, quantity: 1 }],
        })),
      ),
    );

    const rows = Array.from({ length: n }, (_, i) =>
      row({ id: `l${i}`, shopifyOrderId: String(6000 + i) }),
    );
    const res = await backfillMissingItems(rows, CREDS);

    expect(res.recuperadas).toBe(n);
    expect(res.persistidas).toBe(n);
    expect($transaction).toHaveBeenCalledTimes(n);
  });
});

describe('(e) tenant sin credenciales — sin fallback y sin excepción', () => {
  it('sin shopifyStoreUrl no intenta nada', async () => {
    const res = await backfillMissingItems([row()], { shopifyStoreUrl: null, shopifyToken: 'enc:x' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.skipped).toBe('sin-credenciales');
    expect(res.items.size).toBe(0);
  });

  it('sin shopifyToken no intenta nada', async () => {
    const res = await backfillMissingItems([row()], {
      shopifyStoreUrl: 'x.myshopify.com',
      shopifyToken: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.skipped).toBe('sin-credenciales');
  });

  it('token que no se puede descifrar → skip, no throw', async () => {
    const res = await backfillMissingItems([row()], {
      shopifyStoreUrl: 'x.myshopify.com',
      shopifyToken: 'ILEGIBLE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.skipped).toBe('token-ilegible');
  });
});

describe('buildLabelItems — mismos criterios que el worker', () => {
  it('cantidad 0, negativa o no numérica → 1', () => {
    expect(
      buildLabelItems({
        line_items: [
          { sku: 'A', title: 'A', quantity: 0 },
          { sku: 'B', title: 'B', quantity: -3 },
          { sku: 'C', title: 'C', quantity: null },
        ],
      }).map((i) => i.quantity),
    ).toEqual([1, 1, 1]);
  });

  it('cantidad decimal → floor', () => {
    expect(buildLabelItems({ line_items: [{ sku: 'A', title: 'A', quantity: 2.9 }] })[0].quantity).toBe(2);
  });

  it('title vacío pero sku presente → title = sku (NOT NULL en la DB)', () => {
    expect(buildLabelItems({ line_items: [{ sku: 'SKU-1', title: '', quantity: 1 }] })).toEqual([
      { sku: 'SKU-1', title: 'SKU-1', quantity: 1 },
    ]);
  });

  it('ítem sin sku NI título se descarta', () => {
    expect(buildLabelItems({ line_items: [{ sku: '  ', title: '', quantity: 1 }] })).toEqual([]);
  });

  it('NO agrupa: una fila por line_item, igual que el snapshot del worker', () => {
    expect(
      buildLabelItems({
        line_items: [
          { sku: 'A', title: 'A', quantity: 1 },
          { sku: 'A', title: 'A', quantity: 2 },
        ],
      }),
    ).toHaveLength(2);
  });

  it('pedido sin line_items → sin ítems (y sin escritura aguas arriba)', () => {
    expect(buildLabelItems({ line_items: [] })).toEqual([]);
    expect(buildLabelItems(null)).toEqual([]);
  });
});

describe('chunk / applyBackfilledItems', () => {
  it('chunk parte sin perder elementos', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 250)).toEqual([]);
  });

  it('applyBackfilledItems no muta la entrada y sólo copia lo que cambió', () => {
    const a = row({ id: 'a', items: [{ sku: 'X', title: 'X', quantity: 1 }] });
    const b = row({ id: 'b' });
    const out = applyBackfilledItems([a, b], new Map([['b', [{ sku: 'Y', title: 'Y', quantity: 2 }]]]));

    expect(b.items).toEqual([]); // la original quedó intacta
    expect(out[0]).toBe(a); // sin cambio → misma referencia
    expect(out[1].items).toEqual([{ sku: 'Y', title: 'Y', quantity: 2 }]);
  });

  it('sin nada recuperado devuelve el mismo array', () => {
    const rows = [row()];
    expect(applyBackfilledItems(rows, new Map())).toBe(rows);
  });
});
