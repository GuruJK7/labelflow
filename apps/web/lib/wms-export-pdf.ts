/**
 * Firma de los PDFs de la tanda para el export al WMS (DEPO).
 *
 * ── Por qué existe (2026-09-01) ──────────────────────────────────────────────
 * DEPO imprime las etiquetas del día desde su propia pantalla (`/etiquetas`), y
 * para eso necesita el PDF de cada una. Hasta ahora el export mandaba los datos
 * del pedido pero no el papel, así que el operador tenía que ir al portal del
 * cliente a bajarlos de a uno. Este módulo agrega `pdf_url` a cada pedido.
 *
 * ── El camino de firma es el que YA existe, no uno nuevo ────────────────────
 * Toda la firma pasa por `signedLabelPdfUrl()` de lib/label-pdf.ts — el mismo
 * helper que usa el portal (`/api/public/label-pdf`) y la ruta multi-tienda:
 * POST a `/storage/v1/object/sign/<bucket>/<pdfPath>` con la service role key y
 * `expiresIn` = LABEL_PDF_SIGNED_URL_TTL_SECONDS. Acá NO se arma ninguna URL a
 * mano; lo único que agrega este archivo es el fan-out acotado y el reloj.
 *
 * ── Reglas de diseño ────────────────────────────────────────────────────────
 *
 *  1. NUNCA rompe el export. Storage sin configurar, un 404, un timeout o el
 *     bucket caído dan `pdf_url: null` en esa etiqueta y nada más. El export
 *     vale por los datos del pedido; el PDF es un extra.
 *
 *  2. Fan-out acotado. Una tanda grande son cientos de etiquetas y cada firma
 *     es un POST: sin límite se abrirían cientos de sockets de una. Mismo tope
 *     que usa /api/public/label-pdf/bulk para el mismo bucket.
 *
 *  3. Presupuesto de tiempo. La ruta tiene `maxDuration = 60` y ya gasta parte
 *     en el backfill de ítems contra Shopify. La firma se corta a los
 *     SIGN_BUDGET_MS: lo que no llegó a firmarse sale null y el export
 *     responde igual. Preferimos una tanda con algunos PDFs faltando antes que
 *     un 504 sin tanda.
 *
 *  4. Sólo se firma lo que se va a exportar. El caller pasa las filas YA
 *     filtradas por zona: `?zona=maldonado` no tiene por qué pagar las firmas
 *     de la pila que se va por DAC.
 *
 *  5. `expira_en` sale del reloj de ACÁ (el instante en que se firmó) + el TTL
 *     del helper, no de un 3600 escrito de nuevo. Si nadie tenía PDF no se
 *     firmó nada y `expira_en` es null: no hay nada que venza.
 */
// Import RELATIVO a propósito (y no '@/lib/label-pdf'): este módulo y su test
// también se cargan bajo la config de vitest de la RAÍZ, que no tiene el alias
// '@'. Con el alias, el archivo entero se caía a "Cannot find package" ahí —
// igual que le pasa hoy a client-view-packseq.test.ts. Mismo criterio que
// wms-export.ts con './departamentos'.
import { LABEL_PDF_SIGNED_URL_TTL_SECONDS, signedLabelPdfUrl } from './label-pdf';

/** Firmas simultáneas contra Supabase Storage. Igual que el bulk del portal. */
const SIGN_CONCURRENCY = 10;

/** Techo por firma individual. Un socket colgado no se come el request entero. */
const SIGN_TIMEOUT_MS = 8_000;

/** Techo del paso completo de firma, dentro del `maxDuration = 60` de la ruta. */
const SIGN_BUDGET_MS = 20_000;

/** Lo mínimo que este módulo necesita de una fila del export. */
export interface SignablePdfRow {
  id: string;
  pdfPath: string | null;
}

export interface WmsExportPdfUrls {
  /** labelId → URL firmada, o null si no había PDF o la firma no salió. */
  urls: ReadonlyMap<string, string | null>;
  /** Etiquetas con `pdfPath` (las que se intentaron firmar). */
  conPdf: number;
  /** Cuántas terminaron con una URL usable. */
  firmadas: number;
  /** ISO 8601 del vencimiento de las URLs, o null si no se firmó ninguna. */
  expiraEn: string | null;
}

const VACIO: WmsExportPdfUrls = {
  urls: new Map(),
  conPdf: 0,
  firmadas: 0,
  expiraEn: null,
};

/**
 * Firma una sola etiqueta. Devuelve null ante CUALQUIER problema (incluido el
 * timeout): el que llama no distingue los motivos porque no cambia lo que hace.
 */
async function firmarUna(pdfPath: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const conTecho = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SIGN_TIMEOUT_MS);
    });
    return await Promise.race([signedLabelPdfUrl(pdfPath), conTecho]);
  } catch (err) {
    console.error('[wms-export] firma de PDF falló:', (err as Error).message, { pdfPath });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Firma los PDFs de `rows` y devuelve el mapa que consume
 * `buildWmsExportPayload({ pdfUrls })`.
 *
 * Las filas sin `pdfPath` no entran al mapa: `toDepoPedido` trata la ausencia
 * igual que un null, así que no hace falta ocupar lugar para decir "no hay".
 */
export async function signWmsExportPdfUrls(
  rows: readonly SignablePdfRow[],
): Promise<WmsExportPdfUrls> {
  const conPdf = rows.filter(
    (r): r is SignablePdfRow & { pdfPath: string } =>
      typeof r.pdfPath === 'string' && r.pdfPath.length > 0,
  );
  if (conPdf.length === 0) return VACIO;

  const urls = new Map<string, string | null>();
  const inicio = Date.now();
  const deadline = inicio + SIGN_BUDGET_MS;
  let cursor = 0;
  let firmadas = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= conPdf.length) return;
      const row = conPdf[i];
      // Presupuesto agotado: el resto sale null, sin ni siquiera intentarlo.
      if (Date.now() >= deadline) {
        urls.set(row.id, null);
        continue;
      }
      const url = await firmarUna(row.pdfPath);
      if (url) firmadas++;
      urls.set(row.id, url);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SIGN_CONCURRENCY, conPdf.length) }, () => worker()),
  );

  return {
    urls,
    conPdf: conPdf.length,
    firmadas,
    // El vencimiento se cuenta desde que EMPEZÓ a firmar, no desde que
    // terminó. Cada URL vence a la hora de SU firma, así que la primera de la
    // tanda es la que menos vida tiene: informar el final haría creer a DEPO
    // que le quedan segundos que a esa primera ya no le quedan. Con el inicio,
    // `expira_en` es el piso — algunas URLs duran un poco más, ninguna menos.
    expiraEn:
      firmadas > 0
        ? new Date(inicio + LABEL_PDF_SIGNED_URL_TTL_SECONDS * 1000).toISOString()
        : null,
  };
}
