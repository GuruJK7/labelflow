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
 *   - el fetch va EN LOTE y se parte en SHOPIFY_IDS_BATCH (el costo calculado
 *     de UNA query de la Admin GraphQL no puede pasar de 1000: sin el corte,
 *     un lote grande vuelve con MAX_COST_EXCEEDED y se pierde entero),
 *   - un tenant sin tienda conectada no rompe nada y no intenta nada.
 *
 * Desde el port a GraphQL (2026-09-16, requisito 2.2.4 del App Store) se suman:
 *   - la llamada va por POST a graphql.json y NUNCA a orders.json,
 *   - los ids viajan como GID y vuelven como GID: si la conversión de vuelta a
 *     numérico se rompe, NINGUNA etiqueta se completa (la clave del Map no
 *     coincidiría con ninguna fila),
 *   - GraphQL contesta 200 CON `errors`: un lote irrecuperable tiene que caer
 *     igual que un 500 de REST, y uno con errores parciales tiene que
 *     aprovechar los nodos que sí vinieron,
 *   - un pedido con más line items que la página se completa con seguimientos
 *     y, si el seguimiento falla, NO sale a medias.
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

// El token del tenant viaja cifrado con ENCRYPTION_KEY y desde D29 se
// resuelve por `shopifyAccessForTenant` (renueva si es del App Store). Acá no
// interesa ni la criptografía ni la renovación (testeadas en sus módulos),
// interesa que el backfill use el access resuelto y que un token ilegible
// (resuelto a null) no explote.
vi.mock('@/lib/shopify-access', () => ({
  shopifyAccessForTenant: async (t: { shopifyToken: string | null }) =>
    !t.shopifyToken ? null : t.shopifyToken === 'ILEGIBLE' ? null : t.shopifyToken.replace(/^enc:/, ''),
}));

import {
  backfillMissingItems,
  applyBackfilledItems,
  buildLabelItems,
  chunk,
  orderIdFromGid,
  toOrderGid,
  SHOPIFY_IDS_BATCH,
  SHOPIFY_LINE_ITEMS_PAGE,
  type BackfillLabelRow,
} from '../wms-items-backfill';
import { buildWmsExportPayload, type WmsExportLabelRow } from '../wms-export';

const CREDS = { id: 't-kinevia', shopifyStoreUrl: 'kinevia.myshopify.com', shopifyToken: 'enc:shpat_123' };

/** Costo calculado de la Admin GraphQL: 1 (Order) + 2 (conexión) + first. */
const COSTO_POR_PEDIDO = 3 + SHOPIFY_LINE_ITEMS_PAGE;
const COSTO_MAXIMO_POR_QUERY = 1000;

function row(over: Partial<BackfillLabelRow> = {}): BackfillLabelRow {
  return { id: 'lbl_1', shopifyOrderId: '5001', items: [], ...over };
}

type LineItem = { sku?: string | null; title?: string | null; quantity?: number | null };

/** Respuesta cruda de graphql.json. El cliente lee `.text()`, no `.json()`. */
function gqlRes(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/** Respuesta OK de la query de lote con los pedidos pedidos. */
function gqlOk(
  orders: { id: number; line_items?: LineItem[] }[],
  opts: { hasNextPage?: boolean; endCursor?: string | null } = {},
) {
  return gqlRes({
    data: {
      nodes: orders.map((o) => ({
        id: toOrderGid(String(o.id)),
        lineItems: {
          pageInfo: { hasNextPage: opts.hasNextPage ?? false, endCursor: opts.endCursor ?? null },
          nodes: o.line_items ?? [],
        },
      })),
    },
  });
}

/** Respuesta OK de la query de seguimiento (una página más de un pedido). */
function gqlOrderPage(id: number, items: LineItem[], next?: string | null) {
  return gqlRes({
    data: {
      order: {
        id: toOrderGid(String(id)),
        lineItems: {
          pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null },
          nodes: items,
        },
      },
    },
  });
}

function bodyOf(call: unknown[]): { query: string; variables: Record<string, unknown> } {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body));
}

function idsOf(call: unknown[]): string[] {
  return bodyOf(call).variables.ids as string[];
}

let fetchMock: ReturnType<typeof vi.fn>;
let avisosLog: string[] = [];

/** Todo lo que el módulo logueó, aplanado, para poder afirmar el MOTIVO. */
function avisos(): string {
  return avisosLog.join('\n');
}

beforeEach(() => {
  deleteMany.mockReset().mockReturnValue({ __op: 'deleteMany' });
  createMany.mockReset().mockReturnValue({ __op: 'createMany' });
  $transaction.mockReset().mockResolvedValue([]);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Un lote perdido se loguea; acá sólo ensucia la salida de los tests, pero el
  // MOTIVO se guarda: varios tests afirman por qué se cayó, no sólo que se cayó.
  avisosLog = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisosLog.push(args.map((a) => JSON.stringify(a)).join(' '));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      gqlOk([{ id: 5002, line_items: [{ sku: 'BUZ-9', title: 'Buzo', quantity: 1 }] }]),
    );

    await backfillMissingItems(
      [
        row({ id: 'a', shopifyOrderId: '5001', items: [{ sku: 'X', title: 'X', quantity: 1 }] }),
        row({ id: 'b', shopifyOrderId: '5002' }),
      ],
      CREDS,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(idsOf(fetchMock.mock.calls[0])).toEqual(['gid://shopify/Order/5002']);
  });
});

describe('(b) backfill — completa desde Shopify y persiste', () => {
  it('devuelve los ítems y escribe LabelItem con la forma del worker', async () => {
    fetchMock.mockResolvedValue(
      gqlOk([
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

  it('va por GraphQL (2.2.4), con el token DESCIFRADO y la store del tenant', async () => {
    fetchMock.mockResolvedValue(gqlOk([]));
    await backfillMissingItems([row()], CREDS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://kinevia.myshopify.com/admin/api/2026-07/graphql.json');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123');

    // Ni un rastro del recurso REST: eso es lo que reprueba el requisito 2.2.4.
    expect(url).not.toContain('orders.json');
    expect(url).not.toContain('/admin/api/2024-01/');

    const { query, variables } = bodyOf(fetchMock.mock.calls[0]);
    expect(query).toContain('nodes(ids: $ids)');
    expect(query).toContain('... on Order');
    expect(query).toContain('lineItems(first: $liFirst)');
    expect(query).toContain('sku');
    expect(query).toContain('title');
    expect(query).toContain('quantity');
    expect(variables.ids).toEqual(['gid://shopify/Order/5001']);
    expect(variables.liFirst).toBe(SHOPIFY_LINE_ITEMS_PAGE);
  });

  it('si la escritura falla igual devuelve los ítems (best-effort)', async () => {
    fetchMock.mockResolvedValue(
      gqlOk([{ id: 5001, line_items: [{ sku: 'A', title: 'A', quantity: 1 }] }]),
    );
    $transaction.mockRejectedValue(new Error('deadlock'));

    const res = await backfillMissingItems([row()], CREDS);

    expect(res.recuperadas).toBe(1);
    expect(res.persistidas).toBe(0);
    expect(res.items.get('lbl_1')).toHaveLength(1);
  });

  it('la etiqueta de reparto propio (guía LF-) también se completa', async () => {
    fetchMock.mockResolvedValue(
      gqlOk([{ id: 7777, line_items: [{ sku: 'LF-1', title: 'Caja', quantity: 3 }] }]),
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

describe('(b2) GID ↔ id numérico — la costura del port', () => {
  it('ida y vuelta', () => {
    expect(toOrderGid('5001')).toBe('gid://shopify/Order/5001');
    expect(orderIdFromGid('gid://shopify/Order/5001')).toBe('5001');
    expect(orderIdFromGid(toOrderGid('7777'))).toBe('7777');
  });

  it('tolera el sufijo ?key=value y descarta lo que no es un GID de pedido', () => {
    expect(orderIdFromGid('gid://shopify/Order/5001?namespace=x')).toBe('5001');
    expect(orderIdFromGid(null)).toBeNull();
    expect(orderIdFromGid(undefined)).toBeNull();
    expect(orderIdFromGid('')).toBeNull();
    expect(orderIdFromGid({})).toBeNull();
  });

  it('la clave del Map es el id NUMÉRICO, que es lo que guarda Label.shopifyOrderId', async () => {
    fetchMock.mockResolvedValue(
      gqlOk([{ id: 5001, line_items: [{ sku: 'A', title: 'A', quantity: 1 }] }]),
    );
    // Si la respuesta se indexara por GID, esto daría 0 recuperadas.
    const res = await backfillMissingItems([row({ shopifyOrderId: '5001' })], CREDS);
    expect(res.recuperadas).toBe(1);
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
    fetchMock.mockResolvedValue(gqlRes({}, 429));
    const res = await backfillMissingItems([row()], CREDS);
    expect(res.recuperadas).toBe(0);
    expect(avisos()).toContain('429');
  });

  it('200 con `errors` y sin data (THROTTLED) se trata como lote caído', async () => {
    // El modo de falla propio de GraphQL: el status NO alcanza para saber si
    // salió bien. Si esto se chequeara sólo por res.ok, el lote se daría por
    // bueno y las etiquetas saldrían vacías sin que nadie se entere.
    fetchMock.mockResolvedValue(
      gqlRes({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
    );

    const res = await backfillMissingItems([row()], CREDS);

    expect(res.recuperadas).toBe(0);
    expect(res.items.size).toBe(0);
    expect($transaction).not.toHaveBeenCalled();
    // Y el motivo REAL tiene que llegar al log: si el módulo sólo mirara el
    // status HTTP, el lote caería igual pero por un TypeError de rebote y
    // nadie podría saber por qué el export quedó entero en `sin_items`.
    expect(avisos()).toContain('THROTTLED');
  });

  it('errores PARCIALES: el nodo que sí vino se aprovecha', async () => {
    // Un pedido fuera de la ventana de 60 días vuelve como null (o con su
    // error) sin invalidar a los demás del lote.
    fetchMock.mockResolvedValue(
      gqlRes({
        data: {
          nodes: [
            null,
            {
              id: toOrderGid('5002'),
              lineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ sku: 'B', title: 'Buzo', quantity: 1 }],
              },
            },
          ],
        },
        errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }],
      }),
    );

    const res = await backfillMissingItems(
      [row({ id: 'viejo', shopifyOrderId: '5001' }), row({ id: 'nuevo', shopifyOrderId: '5002' })],
      CREDS,
    );

    expect(res.items.get('nuevo')).toEqual([{ sku: 'B', title: 'Buzo', quantity: 1 }]);
    expect(res.items.has('viejo')).toBe(false);
    expect(res.recuperadas).toBe(1);
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

describe('(d) lotes — el fetch se parte en SHOPIFY_IDS_BATCH', () => {
  it('2 lotes + 1 generan 3 requests, y ninguno se pasa del costo máximo', async () => {
    fetchMock.mockResolvedValue(gqlOk([]));

    const n = SHOPIFY_IDS_BATCH * 2 + 1;
    const rows = Array.from({ length: n }, (_, i) =>
      row({ id: `l${i}`, shopifyOrderId: String(9000 + i) }),
    );
    await backfillMissingItems(rows, CREDS);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(idsOf(fetchMock.mock.calls[0])).toHaveLength(SHOPIFY_IDS_BATCH);
    expect(idsOf(fetchMock.mock.calls[1])).toHaveLength(SHOPIFY_IDS_BATCH);
    expect(idsOf(fetchMock.mock.calls[2])).toHaveLength(1);

    for (const call of fetchMock.mock.calls) {
      const ids = idsOf(call);
      expect(ids.length * COSTO_POR_PEDIDO).toBeLessThanOrEqual(COSTO_MAXIMO_POR_QUERY);
      expect(ids.every((g) => g.startsWith('gid://shopify/Order/'))).toBe(true);
    }
  });

  it('la tanda típica (64 etiquetas) sigue siendo UN solo request', async () => {
    fetchMock.mockResolvedValue(gqlOk([]));
    const rows = Array.from({ length: 64 }, (_, i) =>
      row({ id: `l${i}`, shopifyOrderId: String(9000 + i) }),
    );
    await backfillMissingItems(rows, CREDS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('un lote que falla no se lleva puesto al otro', async () => {
    const n = SHOPIFY_IDS_BATCH * 2 + 1;
    const ultimoPedido = 9000 + (n - 1);

    fetchMock
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(
        gqlOk([{ id: ultimoPedido, line_items: [{ sku: 'Z', title: 'Z', quantity: 1 }] }]),
      );

    const rows = Array.from({ length: n }, (_, i) =>
      row({ id: `l${i}`, shopifyOrderId: String(9000 + i) }),
    );
    const res = await backfillMissingItems(rows, CREDS);

    expect(res.recuperadas).toBe(1);
    expect(res.items.get(`l${n - 1}`)).toEqual([{ sku: 'Z', title: 'Z', quantity: 1 }]);
  });

  it('MAX_COST_EXCEEDED parte el lote en dos y reintenta', async () => {
    // Red de seguridad: si la cuenta de costo de Shopify cambiara, el backfill
    // se pone lento — no se apaga en silencio.
    fetchMock
      .mockResolvedValueOnce(
        gqlRes({
          errors: [
            {
              message: 'Query cost is 2003, which exceeds the single query max cost limit (1000).',
              extensions: { code: 'MAX_COST_EXCEEDED', cost: 2003, maxCost: 1000 },
            },
          ],
        }),
      )
      .mockResolvedValue(gqlOk([{ id: 5001, line_items: [{ sku: 'A', title: 'A', quantity: 1 }] }]));

    const res = await backfillMissingItems(
      [row({ id: 'a', shopifyOrderId: '5001' }), row({ id: 'b', shopifyOrderId: '5002' })],
      CREDS,
    );

    expect(fetchMock.mock.calls.length).toBe(3); // el lote entero + las dos mitades
    expect(idsOf(fetchMock.mock.calls[0])).toHaveLength(2);
    expect(idsOf(fetchMock.mock.calls[1])).toHaveLength(1);
    expect(res.items.get('a')).toEqual([{ sku: 'A', title: 'A', quantity: 1 }]);
  });

  it('ids duplicados (envío partido) se piden una sola vez', async () => {
    fetchMock.mockResolvedValue(
      gqlOk([{ id: 5001, line_items: [{ sku: 'A', title: 'A', quantity: 1 }] }]),
    );
    const res = await backfillMissingItems(
      [row({ id: 'a', shopifyOrderId: '5001' }), row({ id: 'b', shopifyOrderId: '5001' })],
      CREDS,
    );
    expect(idsOf(fetchMock.mock.calls[0])).toEqual(['gid://shopify/Order/5001']);
    // Pero las DOS Labels se completan con ese pedido.
    expect(res.recuperadas).toBe(2);
  });

  it('los writes van en tandas y NINGUNA etiqueta se pierde en el camino', async () => {
    // Más que PERSIST_CONCURRENCY: es donde se rompería un chunk mal escrito.
    const n = 20;
    fetchMock.mockResolvedValue(
      gqlOk(
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

describe('(d2) line items paginados — lo que REST traía entero', () => {
  it('un pedido con más ítems que la página se completa con un seguimiento', async () => {
    const primera = Array.from({ length: SHOPIFY_LINE_ITEMS_PAGE }, (_, i) => ({
      sku: `S${i}`,
      title: `T${i}`,
      quantity: 1,
    }));

    fetchMock
      .mockResolvedValueOnce(
        gqlOk([{ id: 5001, line_items: primera }], { hasNextPage: true, endCursor: 'cur1' }),
      )
      .mockResolvedValueOnce(gqlOrderPage(5001, [{ sku: 'EXTRA', title: 'Extra', quantity: 2 }]));

    const res = await backfillMissingItems([row()], CREDS);

    expect(res.items.get('lbl_1')).toHaveLength(SHOPIFY_LINE_ITEMS_PAGE + 1);
    expect(res.items.get('lbl_1')!.at(-1)).toEqual({ sku: 'EXTRA', title: 'Extra', quantity: 2 });

    const seguimiento = bodyOf(fetchMock.mock.calls[1]);
    expect(seguimiento.query).toContain('order(id: $id)');
    expect(seguimiento.variables.after).toBe('cur1');
    expect(seguimiento.variables.id).toBe('gid://shopify/Order/5001');
  });

  it('si el seguimiento falla, el pedido NO sale con la lista a medias', async () => {
    // Media lista de picking se despacha incompleta y nadie se entera; en
    // `sin_items` se ve. Entre las dos, `sin_items`.
    fetchMock
      .mockResolvedValueOnce(
        gqlOk([{ id: 5001, line_items: [{ sku: 'A', title: 'A', quantity: 1 }] }], {
          hasNextPage: true,
          endCursor: 'cur1',
        }),
      )
      .mockRejectedValueOnce(new Error('timeout'));

    const res = await backfillMissingItems([row()], CREDS);

    expect(res.recuperadas).toBe(0);
    expect(res.items.size).toBe(0);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('el seguimiento que falla no se lleva puesto al pedido vecino', async () => {
    fetchMock
      .mockResolvedValueOnce(
        gqlRes({
          data: {
            nodes: [
              {
                id: toOrderGid('5001'),
                lineItems: {
                  pageInfo: { hasNextPage: true, endCursor: 'cur1' },
                  nodes: [{ sku: 'A', title: 'A', quantity: 1 }],
                },
              },
              {
                id: toOrderGid('5002'),
                lineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ sku: 'B', title: 'B', quantity: 1 }],
                },
              },
            ],
          },
        }),
      )
      .mockRejectedValueOnce(new Error('timeout'));

    const res = await backfillMissingItems(
      [row({ id: 'a', shopifyOrderId: '5001' }), row({ id: 'b', shopifyOrderId: '5002' })],
      CREDS,
    );

    expect(res.items.has('a')).toBe(false);
    expect(res.items.get('b')).toEqual([{ sku: 'B', title: 'B', quantity: 1 }]);
  });
});

describe('(e) tenant sin credenciales — sin fallback y sin excepción', () => {
  it('sin shopifyStoreUrl no intenta nada', async () => {
    const res = await backfillMissingItems([row()], { id: 't', shopifyStoreUrl: null, shopifyToken: 'enc:x' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.skipped).toBe('sin-credenciales');
    expect(res.items.size).toBe(0);
  });

  it('sin shopifyToken no intenta nada', async () => {
    const res = await backfillMissingItems([row()], {
      id: 't',
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
