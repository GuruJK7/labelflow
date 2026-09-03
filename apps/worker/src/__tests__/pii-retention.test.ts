import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Retención de datos personales.
 *
 * 🔴 QUÉ ARREGLA. La política de privacidad (cláusula 6) promete que los datos
 * personales «serán eliminados de forma automática y definitiva» a los 24
 * meses. Hasta el 2026-09-03 nada lo hacía: el único job de retención borra
 * PDFs a los 15 días y su propio comentario aclara que no toca las filas
 * `Label` — que son justamente las que guardan nombre, mail, teléfono y
 * dirección. Un documento legal, bajo Ley 18.331, prometiendo algo que ningún
 * código ejecutaba.
 *
 * Lo que este test fija es la tensión que hay que respetar: se van los datos
 * que identifican a una persona, y SOBREVIVE el registro contable, porque la
 * misma cláusula obliga a conservarlo 5 años para facturación y auditoría.
 */
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), updateMany: vi.fn() }));
vi.mock('../db', () => ({ db: { label: { findMany: mocks.findMany, updateMany: mocks.updateMany } } }));
vi.mock('../logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  runPiiRetention,
  cutoffFor,
  CAMPOS_ANONIMIZADOS,
  ANONIMIZADO,
  PII_RETENTION_MONTHS,
} from '../jobs/pii-retention.job';

beforeEach(() => {
  // `clearAllMocks` borra las LLAMADAS pero no las implementaciones: los
  // `mockResolvedValueOnce` que un test deja sin consumir quedan en cola y se
  // los come el test siguiente. Pasó: el de truncado recibía el `[]` sobrante
  // del de idempotencia y salía en cero.
  mocks.findMany.mockReset();
  mocks.updateMany.mockReset();
  mocks.updateMany.mockResolvedValue({ count: 0 });
});

describe('el plazo', () => {
  it('son 24 meses, los mismos que promete la política de privacidad', () => {
    expect(PII_RETENTION_MONTHS).toBe(24);
  });

  it('el corte cae exactamente 24 meses atrás', () => {
    expect(cutoffFor(new Date('2026-09-03T00:00:00Z')).toISOString().slice(0, 10)).toBe('2024-09-03');
  });
});

describe('qué se va y qué se queda', () => {
  it('se van los cuatro campos que identifican a una persona', () => {
    expect(Object.keys(CAMPOS_ANONIMIZADOS).sort()).toEqual(
      ['customerEmail', 'customerName', 'customerPhone', 'deliveryAddress'].sort(),
    );
  });

  it('🔴 NO toca la guía, los montos ni la ciudad: el registro contable vive 5 años', () => {
    for (const campo of ['dacGuia', 'totalUyu', 'city', 'department', 'shopifyOrderName', 'status']) {
      expect(CAMPOS_ANONIMIZADOS).not.toHaveProperty(campo);
    }
  });

  it('los campos opcionales van a null; los NOT NULL llevan la marca', () => {
    expect(CAMPOS_ANONIMIZADOS.customerEmail).toBeNull();
    expect(CAMPOS_ANONIMIZADOS.customerPhone).toBeNull();
    expect(CAMPOS_ANONIMIZADOS.customerName).toBe(ANONIMIZADO);
    expect(CAMPOS_ANONIMIZADOS.deliveryAddress).toBe(ANONIMIZADO);
  });
});

describe('la corrida', () => {
  it('sólo toma filas vencidas y todavía sin anonimizar', async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    await runPiiRetention(new Date('2026-09-03T00:00:00Z'));
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.customerName).toEqual({ not: ANONIMIZADO });
    expect(where.createdAt.lt.toISOString().slice(0, 10)).toBe('2024-09-03');
  });

  it('anonimiza por lotes y termina cuando el lote viene incompleto', async () => {
    mocks.findMany
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ id: `a${i}` })))
      .mockResolvedValueOnce([{ id: 'b1' }, { id: 'b2' }]);
    const r = await runPiiRetention();
    expect(r.anonimizadas).toBe(502);
    expect(r.lotes).toBe(2);
    expect(r.truncado).toBe(false);
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.updateMany.mock.calls[0][0].data).toEqual(CAMPOS_ANONIMIZADOS);
  });

  it('sin nada vencido no escribe una sola fila', async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    const r = await runPiiRetention();
    expect(r.anonimizadas).toBe(0);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('es idempotente: la segunda corrida no encuentra nada', async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: 'x' }]).mockResolvedValueOnce([]);
    expect((await runPiiRetention()).anonimizadas).toBe(1);
    mocks.findMany.mockResolvedValueOnce([]);
    expect((await runPiiRetention()).anonimizadas).toBe(0);
  });

  it('un backlog enorme se trunca en vez de acaparar la corrida', async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 500 }, (_, i) => ({ id: `z${i}` })));
    const r = await runPiiRetention();
    expect(r.truncado).toBe(true);
    expect(r.lotes).toBe(40);
    expect(r.anonimizadas).toBe(20_000);
  });
});
