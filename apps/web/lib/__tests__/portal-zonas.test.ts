/**
 * Tests del GATE del split por zonas del portal (`Tenant.portalSplitZonas`).
 *
 * Correr:  npx vitest run --root apps/web
 *
 * Lo que se protege acá es una regresión silenciosa sobre clientes que NO
 * pidieron nada: los 4 portales que ya existen (Curvadivina, Onix, Vastora,
 * Aura) tienen el flag en false y su día tiene que seguir siendo UNA sola pila,
 * en el mismo orden en que venían las etiquetas. Si el gate se rompe, el
 * síntoma es que a esos clientes se les reordena la impresión — y eso no
 * revienta ningún build, se descubre imprimiendo.
 *
 * `zonasDelDia` es la MISMA función que llama ClientPortal.tsx (vive en
 * lib/portal-zonas.ts justamente para poder importarla sin levantar React), no
 * una reimplementación.
 */
import { describe, it, expect } from 'vitest';
import { zonasDelDia } from '../portal-zonas';
import type { ClientViewLabel } from '../client-view';

function label(over: Partial<ClientViewLabel> = {}): ClientViewLabel {
  return {
    id: 'l1',
    storeId: 't1',
    orderName: '#1',
    dacGuia: 'AB123',
    city: 'Punta del Este',
    department: 'Montevideo',
    status: 'CREATED',
    createdAt: '2026-09-01T12:00:00.000Z',
    hasPdf: true,
    printedAt: null,
    ...over,
  };
}

const MALDONADO = label({ id: 'm1', department: 'Maldonado' });
const RESTO = label({ id: 'r1', department: 'Montevideo' });

describe('zonasDelDia — gate por tenant', () => {
  it('sin split: UN solo grupo con TODAS las etiquetas, en el orden de entrada', () => {
    const items = [MALDONADO, RESTO, label({ id: 'm2', department: 'Maldonado' })];
    const zonas = zonasDelDia(items, false);

    expect(zonas).toHaveLength(1);
    expect(zonas[0].key).toBe('todas');
    // El orden es EXACTAMENTE el de entrada: no se reagrupa nada.
    expect(zonas[0].items.map((l) => l.id)).toEqual(['m1', 'r1', 'm2']);
  });

  it('sin split nunca hay corte (zonas.length > 1 es lo que dibuja el subtítulo)', () => {
    const zonas = zonasDelDia([MALDONADO, RESTO], false);
    expect(zonas.length > 1).toBe(false);
  });

  it('sin split y sin etiquetas no devuelve un grupo vacío', () => {
    expect(zonasDelDia([], false)).toEqual([]);
  });

  it('con split: parte en reparto propio y resto, en ese orden', () => {
    const zonas = zonasDelDia([RESTO, MALDONADO], true);

    expect(zonas.map((z) => z.key)).toEqual(['propio', 'resto']);
    expect(zonas[0].items.map((l) => l.id)).toEqual(['m1']);
    expect(zonas[1].items.map((l) => l.id)).toEqual(['r1']);
  });

  it('con split, un día que es todo DAC sigue siendo UN grupo (sin encabezado vacío)', () => {
    const zonas = zonasDelDia([RESTO], true);
    expect(zonas).toHaveLength(1);
    expect(zonas[0].key).toBe('resto');
  });

  it('con split usa el MISMO discriminador que el export (guía LF- también cuenta)', () => {
    const lf = label({ id: 'lf1', department: 'Rocha', dacGuia: 'LF-000001' });
    const zonas = zonasDelDia([lf], true);
    expect(zonas[0].key).toBe('propio');
  });
});

describe('dayPdfIds — el orden que se manda a imprimir', () => {
  /** Réplica literal del cálculo de ClientPortal: zonas primero, después ids. */
  function dayPdfIds(items: ClientViewLabel[], splitZonas: boolean): string[] {
    return zonasDelDia(items, splitZonas)
      .flatMap((z) => z.items)
      .filter((l) => l.hasPdf)
      .map((l) => l.id);
  }

  const items = [
    MALDONADO,
    RESTO,
    label({ id: 'm2', department: 'Maldonado' }),
    label({ id: 'r2', department: 'Canelones', hasPdf: false }),
  ];

  it('sin split, "Imprimir día" mantiene el orden de siempre', () => {
    expect(dayPdfIds(items, false)).toEqual(['m1', 'r1', 'm2']);
  });

  it('con split, sigue el orden de las zonas en pantalla (no el de `items`)', () => {
    // m1, m2 (Maldonado) antes que r1 (resto) — que es como se ven las cards.
    expect(dayPdfIds(items, true)).toEqual(['m1', 'm2', 'r1']);
  });
});
