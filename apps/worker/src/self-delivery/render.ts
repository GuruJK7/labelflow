import { chromium, type Browser } from 'playwright';
import { etiquetaHtml, type DatosEtiqueta } from './label-html';

/**
 * Render de la etiqueta propia a PDF.
 *
 * Usa Playwright (que ya es dependencia del worker por la automatizacion de
 * DAC) en vez de sumar una libreria de PDF: el HTML/CSS da control fino del
 * layout y el PDF sale vectorial, o sea nitido a cualquier DPI de impresora.
 *
 * IMPORTANTE: este modulo abre su PROPIO navegador, aislado del `dacBrowser`.
 * No comparte contexto ni cookies con la sesion de DAC — un pedido de reparto
 * propio nunca toca DAC, y mezclarlos podria interferir con el lock de sesion
 * por tenant.
 */

let navegador: Browser | null = null;

/** Navegador perezoso y reutilizado: lanzar Chromium cuesta ~300 ms. */
async function obtenerNavegador(): Promise<Browser> {
  if (navegador && navegador.isConnected()) return navegador;
  navegador = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return navegador;
}

/** Cierra el navegador de etiquetas. Llamar al terminar el job. */
export async function cerrarRenderer(): Promise<void> {
  if (navegador) {
    await navegador.close().catch(() => {});
    navegador = null;
  }
}

/** Genera el PDF de la etiqueta (10 x 15 cm) y lo devuelve como Buffer. */
export async function renderEtiquetaPdf(datos: DatosEtiqueta): Promise<Buffer> {
  const b = await obtenerNavegador();
  const pagina = await b.newPage();
  try {
    await pagina.setContent(etiquetaHtml(datos), { waitUntil: 'load' });
    return await pagina.pdf({
      width: '100mm',
      height: '150mm',
      printBackground: true, // sin esto las bandas negras salen en blanco
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await pagina.close().catch(() => {});
  }
}

/** Igual pero PNG — para previsualizar en pantalla, no para imprimir. */
export async function renderEtiquetaPng(datos: DatosEtiqueta, escala = 3): Promise<Buffer> {
  const b = await obtenerNavegador();
  const pagina = await b.newPage({
    viewport: { width: 378, height: 567 }, // 100x150 mm a 96 dpi
    deviceScaleFactor: escala,
  });
  try {
    await pagina.setContent(etiquetaHtml(datos), { waitUntil: 'load' });
    return await pagina.screenshot({ type: 'png' });
  } finally {
    await pagina.close().catch(() => {});
  }
}
