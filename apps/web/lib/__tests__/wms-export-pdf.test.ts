/**
 * Tests de la firma de PDFs para el export al WMS (lib/wms-export-pdf.ts).
 *
 * Correr:  ./node_modules/.bin/vitest run --root apps/web
 *
 * Lo que tiene que quedar clavado:
 *   - una firma que falla NUNCA rompe el export: esa etiqueta sale null y el
 *     resto de la tanda se firma igual,
 *   - el mapa cruza por labelId (una URL en la etiqueta equivocada haría que el
 *     operario imprima el papel de otro pedido),
 *   - `expira_en` sale del TTL real del helper compartido, no de un número
 *     escrito de nuevo acá.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const signedLabelPdfUrl = vi.fn<(pdfPath: string) => Promise<string | null>>();

// Se mockea SÓLO `signedLabelPdfUrl` (es la que pega a la red). El resto del
// módulo —en particular LABEL_PDF_SIGNED_URL_TTL_SECONDS— entra real por
// importActual: si el TTL se mockeara, el test de `expira_en` estaría midiendo
// el mock contra sí mismo y un cambio del TTL real pasaría sin que nadie se
// entere, que es justo el error que este archivo tiene que atajar.
vi.mock('../label-pdf', async (importActual) => {
  const actual = await importActual<typeof import('../label-pdf')>();
  return { ...actual, signedLabelPdfUrl: (pdfPath: string) => signedLabelPdfUrl(pdfPath) };
});

const { signWmsExportPdfUrls } = await import('../wms-export-pdf');
const { LABEL_PDF_SIGNED_URL_TTL_SECONDS } = await import('../label-pdf');

function row(id: string, pdfPath: string | null) {
  return { id, pdfPath };
}

beforeEach(() => {
  signedLabelPdfUrl.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signWmsExportPdfUrls', () => {
  it('firma cada etiqueta con pdfPath y las cruza por id', async () => {
    signedLabelPdfUrl.mockImplementation(async (p) => `https://signed/${p}`);

    const res = await signWmsExportPdfUrls([row('a', 'a.pdf'), row('b', 'b.pdf')]);

    expect(res.urls.get('a')).toBe('https://signed/a.pdf');
    expect(res.urls.get('b')).toBe('https://signed/b.pdf');
    expect(res.conPdf).toBe(2);
    expect(res.firmadas).toBe(2);
  });

  it('no intenta firmar las etiquetas sin pdfPath', async () => {
    signedLabelPdfUrl.mockResolvedValue('https://signed/ok.pdf');

    const res = await signWmsExportPdfUrls([row('a', null), row('b', ''), row('c', 'c.pdf')]);

    // Una sola llamada: las históricas sin PDF no gastan un POST al storage.
    expect(signedLabelPdfUrl).toHaveBeenCalledTimes(1);
    expect(signedLabelPdfUrl).toHaveBeenCalledWith('c.pdf');
    expect(res.conPdf).toBe(1);
    // Las que no tienen PDF ni entran al mapa: la ausencia vale null.
    expect(res.urls.has('a')).toBe(false);
    expect(res.urls.has('b')).toBe(false);
  });

  it('sin ninguna etiqueta con PDF no llama al storage y expira_en es null', async () => {
    const res = await signWmsExportPdfUrls([row('a', null)]);

    expect(signedLabelPdfUrl).not.toHaveBeenCalled();
    expect(res).toEqual({ urls: new Map(), conPdf: 0, firmadas: 0, expiraEn: null });
  });

  it('lista vacía devuelve el resultado vacío', async () => {
    const res = await signWmsExportPdfUrls([]);
    expect(res.conPdf).toBe(0);
    expect(res.expiraEn).toBeNull();
  });

  it('una firma que devuelve null no arrastra a las demás', async () => {
    // El helper devuelve null cuando el storage no está configurado o el
    // sign responde !ok. Es el caso "etiqueta vencida por retención".
    signedLabelPdfUrl.mockImplementation(async (p) => (p === 'b.pdf' ? null : `https://signed/${p}`));

    const res = await signWmsExportPdfUrls([
      row('a', 'a.pdf'),
      row('b', 'b.pdf'),
      row('c', 'c.pdf'),
    ]);

    expect(res.urls.get('a')).toBe('https://signed/a.pdf');
    expect(res.urls.get('b')).toBeNull();
    expect(res.urls.get('c')).toBe('https://signed/c.pdf');
    expect(res.conPdf).toBe(3);
    expect(res.firmadas).toBe(2);
  });

  it('una firma que TIRA se traga la excepción y sale null', async () => {
    // Éste es el caso que rompería el export si no estuviera atajado: un
    // throw suelto adentro del pool propaga y la ruta devuelve 500 sin tanda.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    signedLabelPdfUrl.mockImplementation(async (p) => {
      if (p === 'b.pdf') throw new Error('fetch failed');
      return `https://signed/${p}`;
    });

    const res = await signWmsExportPdfUrls([row('a', 'a.pdf'), row('b', 'b.pdf')]);

    expect(res.urls.get('a')).toBe('https://signed/a.pdf');
    expect(res.urls.get('b')).toBeNull();
    expect(res.firmadas).toBe(1);
    err.mockRestore();
  });

  it('si TODAS fallan, expira_en es null (no hay nada que venza)', async () => {
    signedLabelPdfUrl.mockResolvedValue(null);

    const res = await signWmsExportPdfUrls([row('a', 'a.pdf'), row('b', 'b.pdf')]);

    expect(res.firmadas).toBe(0);
    expect(res.expiraEn).toBeNull();
    // Pero el mapa igual trae las claves en null: el pedido sale con
    // `pdf_url: null`, no sin la clave.
    expect(res.urls.get('a')).toBeNull();
  });

  it('expira_en es el inicio de la firma + el TTL REAL del helper compartido', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    signedLabelPdfUrl.mockResolvedValue('https://signed/a.pdf');

    const res = await signWmsExportPdfUrls([row('a', 'a.pdf')]);

    // Derivado del TTL real: esto ata el `expira_en` publicado al `expiresIn`
    // que se le pide a Supabase, pase lo que pase con el número.
    expect(res.expiraEn).toBe(
      new Date(Date.parse('2026-09-01T12:00:00.000Z') + LABEL_PDF_SIGNED_URL_TTL_SECONDS * 1000)
        .toISOString(),
    );
  });

  it('el TTL publicado es de 1 hora', () => {
    // Tripwire a propósito: el valor está documentado en el runbook y en el
    // `meta.expira_en` que lee DEPO. Si alguien lo cambia, que sea una
    // decisión y no un efecto colateral — actualizá también la doc de ops.
    expect(LABEL_PDF_SIGNED_URL_TTL_SECONDS).toBe(3600);
  });

  it('firma una tanda grande entera, sin perder ninguna', async () => {
    // Con fan-out acotado (10 a la vez) el riesgo es que el pool se coma
    // filas o repita índices. 250 etiquetas es más que una tanda real.
    signedLabelPdfUrl.mockImplementation(async (p) => `https://signed/${p}`);
    const rows = Array.from({ length: 250 }, (_, i) => row(`id${i}`, `${i}.pdf`));

    const res = await signWmsExportPdfUrls(rows);

    expect(res.conPdf).toBe(250);
    expect(res.firmadas).toBe(250);
    expect(res.urls.size).toBe(250);
    expect(res.urls.get('id0')).toBe('https://signed/0.pdf');
    expect(res.urls.get('id249')).toBe('https://signed/249.pdf');
    expect(signedLabelPdfUrl).toHaveBeenCalledTimes(250);
  });

  it('no abre más de 10 firmas simultáneas', async () => {
    let enVuelo = 0;
    let pico = 0;
    signedLabelPdfUrl.mockImplementation(async (p) => {
      enVuelo++;
      pico = Math.max(pico, enVuelo);
      await new Promise((r) => setTimeout(r, 1));
      enVuelo--;
      return `https://signed/${p}`;
    });

    await signWmsExportPdfUrls(Array.from({ length: 40 }, (_, i) => row(`id${i}`, `${i}.pdf`)));

    expect(pico).toBeLessThanOrEqual(10);
  });
});
