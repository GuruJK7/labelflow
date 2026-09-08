import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Retención de `RunLog`.
 *
 * 🔴 QUÉ ARREGLA. El 2026-09-08 la base de producción pesaba 769 MB contra un
 * límite de 500 MB, y 697 MB era esta sola tabla. No había ninguna retención.
 *
 * Lo que estos tests fijan no es "que borre": es QUÉ NO BORRA. Un error acá se
 * paga perdiendo datos que no vuelven.
 */
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), deleteMany: vi.fn() }));
vi.mock('../db', () => ({ db: { runLog: { findMany: mocks.findMany, deleteMany: mocks.deleteMany } } }));
vi.mock('../logger', () => ({ default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  runRunLogRetention,
  filtroDeBorrado,
  MENSAJES_PROTEGIDOS,
  TRAZA_DIAS,
  TRAZA_ERROR_DIAS,
  MAX_LOTES,
  LOTE,
} from '../jobs/runlog-retention.job';

const AHORA = new Date('2026-09-08T12:00:00Z');

beforeEach(() => {
  mocks.findMany.mockReset();
  mocks.deleteMany.mockReset();
  mocks.deleteMany.mockImplementation(({ where }: any) => ({ count: where.id.in.length }));
});

describe('el tope por corrida', () => {
  it('🔴 alcanza para comerse el atraso del 08-09 (1.455.011 filas) de una corrida', () => {
    expect(LOTE * MAX_LOTES).toBeGreaterThan(1_455_011);
  });
});

describe('las dos ventanas', () => {
  it('la traza normal vive 7 días y la de fallas 30', () => {
    expect(TRAZA_DIAS).toBe(7);
    expect(TRAZA_ERROR_DIAS).toBe(30);
    expect(TRAZA_ERROR_DIAS).toBeGreaterThan(TRAZA_DIAS);
  });

  it('INFO/SUCCESS se cortan a los 7 días; WARN/ERROR a los 30', () => {
    const f: any = filtroDeBorrado(AHORA);
    const [normal, falla] = f.OR;
    expect(normal.level.in).toEqual(['INFO', 'SUCCESS']);
    expect(normal.createdAt.lt.toISOString()).toBe('2026-09-01T12:00:00.000Z');
    expect(falla.level.in).toEqual(['WARN', 'ERROR']);
    expect(falla.createdAt.lt.toISOString()).toBe('2026-08-09T12:00:00.000Z');
  });

  it('🔴 la ventana de 7 días no puede alcanzar a un job en curso', () => {
    const f: any = filtroDeBorrado(AHORA);
    const masViejo = f.OR.reduce((a: any, b: any) => (a.createdAt.lt < b.createdAt.lt ? b : a));
    expect(AHORA.getTime() - masViejo.createdAt.lt.getTime()).toBeGreaterThanOrEqual(24 * 3600 * 1000);
  });
});

describe('qué NO se borra', () => {
  it('🔴 los mensajes de negocio: sólo entra lo que empieza con "["', () => {
    const f: any = filtroDeBorrado(AHORA);
    expect(f.message).toEqual({ startsWith: '[' });
  });

  it('🔴 los reportes de personas, aunque empiecen con "["', () => {
    const f: any = filtroDeBorrado(AHORA);
    const excluidos = f.AND.map((c: any) => c.message.not.contains);
    for (const m of MENSAJES_PROTEGIDOS) expect(excluidos).toContain(m);
  });

  it('los tres que lee /api/v1/chat/report están cubiertos', () => {
    expect([...MENSAJES_PROTEGIDOS].sort()).toEqual(['AYUDA', 'BUG REPORT', 'FEEDBACK']);
  });
});

describe('la corrida', () => {
  it('borra por lotes y termina sola cuando no queda nada', async () => {
    mocks.findMany
      .mockResolvedValueOnce(Array.from({ length: LOTE }, (_, i) => ({ id: `a${i}` })))
      .mockResolvedValueOnce([{ id: 'b1' }, { id: 'b2' }]);
    const r = await runRunLogRetention(AHORA);
    expect(r).toEqual({ borradas: LOTE + 2, lotes: 2, truncado: false });
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
  });

  it('con la tabla ya limpia no ejecuta ningún borrado', async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    const r = await runRunLogRetention(AHORA);
    expect(r.borradas).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it('avisa cuando cortó por el tope y deja el resto para mañana', async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: LOTE }, (_, i) => ({ id: `x${i}` })));
    const r = await runRunLogRetention(AHORA);
    expect(r.truncado).toBe(true);
    expect(r.lotes).toBe(MAX_LOTES);
  });

  it('borra exactamente los ids que trajo, no re-consulta por filtro', async () => {
    mocks.findMany.mockResolvedValueOnce([{ id: 'z1' }]);
    await runRunLogRetention(AHORA);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['z1'] } } });
  });
});
