// "Preparado" en Shopify tiene que significar que la etiqueta EXISTE y se puede
// imprimir, no sólo que DAC devolvió un número de guía.
//
// EL DEFECTO QUE ESTO FIJA. Emitir la guía y bajar el PDF son dos pasos; el
// fulfillment se disparaba con el primero. Si el segundo fallaba, el pedido le
// quedaba al comerciante en verde mientras el portal mostraba "Sin PDF": no
// podía imprimir, el paquete no salía, y se enteraba por el reclamo del
// comprador. El job YA sabía que había fallado (marca NEEDS_REVIEW y no cobra),
// pero igual le decía a Shopify que estaba preparado.
//
// 🔴 LA GUARDA NO SE SACA "PARA SIMPLIFICAR". Sacarla devuelve exactamente el
// incidente del 06-09 (152 etiquetas con guía y sin PDF, Kinevia y Todo a Mano
// entre los portales afectados). El último test de este archivo fija que los DOS
// jobs sigan pasando por la regla, porque el mismo defecto estaba duplicado.

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { permiteFulfillSinPdf, etiquetaEsImprimible } from '../fulfill-solo-con-etiqueta';

const ORIGINAL = process.env.FULFILL_SIN_PDF_TENANTS;

beforeEach(() => {
  delete process.env.FULFILL_SIN_PDF_TENANTS;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FULFILL_SIN_PDF_TENANTS;
  else process.env.FULFILL_SIN_PDF_TENANTS = ORIGINAL;
});

describe('fulfill sólo con etiqueta imprimible', () => {
  it('sin PDF NO se puede marcar preparado (queda visible en Shopify)', () => {
    expect(etiquetaEsImprimible(false, 'tenant-kinevia')).toBe(false);
  });

  it('con PDF se marca preparado, igual que siempre', () => {
    expect(etiquetaEsImprimible(true, 'tenant-kinevia')).toBe(true);
  });

  it('por defecto ninguna tienda está exceptuada', () => {
    expect(permiteFulfillSinPdf('tenant-kinevia')).toBe(false);
  });

  it('la escotilla es por tienda, nunca global', () => {
    process.env.FULFILL_SIN_PDF_TENANTS = 'tenant-otra';
    expect(permiteFulfillSinPdf('tenant-otra')).toBe(true);
    expect(permiteFulfillSinPdf('tenant-kinevia')).toBe(false);
  });

  it('una tienda exceptuada vuelve al comportamiento viejo', () => {
    process.env.FULFILL_SIN_PDF_TENANTS = 'tenant-vieja';
    expect(etiquetaEsImprimible(false, 'tenant-vieja')).toBe(true);
  });

  it('tolera espacios y entradas vacías en la lista', () => {
    process.env.FULFILL_SIN_PDF_TENANTS = ' tenant-a , , tenant-b ';
    expect(permiteFulfillSinPdf('tenant-a')).toBe(true);
    expect(permiteFulfillSinPdf('tenant-b')).toBe(true);
    expect(permiteFulfillSinPdf('')).toBe(false);
  });

  it('una lista vacía no exceptúa a nadie (ni al tenant vacío)', () => {
    process.env.FULFILL_SIN_PDF_TENANTS = '   ';
    expect(permiteFulfillSinPdf('tenant-kinevia')).toBe(false);
    expect(permiteFulfillSinPdf('')).toBe(false);
  });

  it('los DOS jobs pasan por la regla — si este test falla, alguien la sacó', () => {
    // Sin `import.meta`: el tsconfig del worker no lo permite y este test tiene
    // que pasar el mismo gate que el resto (tsc --noEmit). Vitest corre con cwd
    // en apps/worker o en la raíz del repo según cómo se lo invoque.
    const raiz = process.cwd().endsWith(join('apps', 'worker'))
      ? process.cwd()
      : resolve(process.cwd(), 'apps', 'worker');
    for (const job of ['process-orders.job.ts', 'agent-bulk-upload.job.ts']) {
      const src = readFileSync(resolve(raiz, 'src', 'jobs', job), 'utf8');
      expect(src, `${job} ya no importa la regla`).toContain('etiquetaEsImprimible(');
      expect(src, `${job} fulfillea sin mirar la etiqueta`).toMatch(
        /shouldFulfill && etiquetaImprimible/,
      );
    }
  });
});
