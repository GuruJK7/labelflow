import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Retención de PDFs por "ya lo imprimieron".
 *
 * Viene de Adrian (07-09-2026): «los usuarios al imprimir las etiquetas, y
 * pasan 2 días de que imprimieron eso, no las necesitan más».
 *
 * 🔴 LO QUE ESTOS TESTS PROTEGEN es el tope duro por `createdAt`. `printedAt`
 * lo sella SÓLO el portal del cliente, nunca el panel de admin: medido el
 * 08-09, Curvadivina, Enerva Ventas y Enerva tienen printedAt en CERO. Si
 * alguien "simplifica" esto a una sola condición por printedAt, a esas tiendas
 * los PDFs no se les borran nunca.
 */
const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../db', () => ({ db: { label: { findMany: mocks.findMany, updateMany: mocks.updateMany } } }));
vi.mock('../logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../storage/upload', () => ({ removeLabelPdfs: mocks.remove }));

import { runPdfRetention, RETENTION_DAYS, PRINTED_RETENTION_DAYS } from '../jobs/pdf-retention.job';

beforeEach(() => {
  mocks.findMany.mockReset();
  mocks.updateMany.mockReset();
  mocks.remove.mockReset();
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.remove.mockResolvedValue({ deleted: 1, error: null });
});

describe('las dos ventanas', () => {
  it('impresa: 3 días — dos, más el fin de semana', () => {
    expect(PRINTED_RETENTION_DAYS).toBe(3);
  });

  it('🔴 el tope duro sigue siendo 15 días y es MÁS largo que el de impresa', () => {
    expect(RETENTION_DAYS).toBe(15);
    expect(RETENTION_DAYS).toBeGreaterThan(PRINTED_RETENTION_DAYS);
  });
});

describe('el filtro', () => {
  it('🔴 pregunta por las DOS condiciones, no sólo por printedAt', async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    await runPdfRetention();
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.pdfPath).toEqual({ not: null });
    expect(where.OR).toHaveLength(2);
    const campos = where.OR.map((c: any) => Object.keys(c)[0]).sort();
    expect(campos).toEqual(['createdAt', 'printedAt']);
  });

  it('la ventana de impresa cae después que la de creada', async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    await runPdfRetention();
    const where = mocks.findMany.mock.calls[0][0].where;
    const impresa = where.OR.find((c: any) => c.printedAt).printedAt.lt as Date;
    const creada = where.OR.find((c: any) => c.createdAt).createdAt.lt as Date;
    expect(impresa.getTime()).toBeGreaterThan(creada.getTime());
  });
});

describe('lo que no cambió', () => {
  it('sigue borrando el archivo ANTES de limpiar la fila', async () => {
    mocks.findMany
      .mockResolvedValueOnce([{ id: 'l1', pdfPath: 't/2026-09-01/l1.pdf' }])
      .mockResolvedValueOnce([]);
    await runPdfRetention();
    expect(mocks.remove).toHaveBeenCalledWith(['t/2026-09-01/l1.pdf']);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1'] } },
      data: { pdfPath: null, pdfUrl: null },
    });
  });

  it('🔴 si el storage falla NO limpia la fila: nunca una fila sin archivo', async () => {
    mocks.remove.mockResolvedValueOnce({ deleted: 0, error: 'storage caído' });
    mocks.findMany.mockResolvedValueOnce([{ id: 'l1', pdfPath: 't/x/l1.pdf' }]);
    await runPdfRetention();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
