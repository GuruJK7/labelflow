import { Page } from 'playwright';
import { DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import logger from '../logger';
import fs from 'fs';
import path from 'path';

/**
 * Downloads a shipping label PDF ("Obtener Guia") from DAC's history page.
 *
 * DAC historial structure per row:
 *   - "Rastrear envío"    → /envios/rastreo/Codigo_Rastreo/{codigoRastreo}
 *   - "Reenviar Guia"     → javascript:; (re-sends email)
 *   - "Obtener Guia"      → /envios/getGuia?K_Oficina={oficina}&K_Guia={guia}  ← THIS IS THE PDF
 *   - "Imprimir etiqueta" → /envios/getPegote?CodigoRastreo={codigoRastreo}   (small sticker label)
 *
 * The guia parameter (e.g. "882277502518") is the full tracking code.
 * The URL uses K_Oficina (first 3 digits) and K_Guia (remaining digits).
 *
 * IMPORTANT: Do NOT use generic selectors like a[href*=".pdf"] — the navbar has
 * a "Horarios Turismo" PDF link that would be matched instead.
 */
export async function downloadLabel(
  page: Page,
  guia: string,
  outputDir: string,
  dacUsername: string,
  dacPassword: string
): Promise<string> {
  await ensureLoggedIn(page, dacUsername, dacPassword);

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${guia}.pdf`);

  logger.info({ guia, outputDir }, 'Downloading label from DAC');

  // Navigate to history page (/envios — NOT /envios/cart which is the empty cart)
  await page.goto('https://www.dac.com.uy/envios', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  try {
    // Strategy 1: Find "Obtener Guia" link directly by text
    // This is the most reliable — matches the exact button shown in the UI
    const obtenerGuiaLink = await page.$('a:has-text("Obtener Guia")');

    if (obtenerGuiaLink) {
      const href = await obtenerGuiaLink.getAttribute('href');
      logger.info({ guia, href }, 'Found "Obtener Guia" link');

      if (href && href.startsWith('/envios/getGuia')) {
        // Direct download via URL (more reliable than click-and-wait)
        const fullUrl = `https://www.dac.com.uy${href}`;
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const axios = (await import('axios')).default;

        const response = await axios.get(fullUrl, {
          responseType: 'arraybuffer',
          headers: { Cookie: cookieHeader },
          timeout: 30_000,
        });

        // Verify we got a PDF (not an HTML error page)
        const contentType = response.headers['content-type'] || '';
        const buffer = Buffer.from(response.data);

        if (contentType.includes('application/pdf') || buffer.subarray(0, 5).toString() === '%PDF-') {
          fs.writeFileSync(outputPath, buffer);
          logger.info({ guia, path: outputPath, size: buffer.length }, 'Label PDF downloaded via Obtener Guia');
          return outputPath;
        } else {
          logger.warn({ guia, contentType, size: buffer.length }, 'Obtener Guia returned non-PDF content');
        }
      }
    }

    // Strategy 2: Find by href pattern /envios/getGuia
    // In case the link text changes or there are multiple shipments
    const getGuiaLinks = await page.$$('a[href*="/envios/getGuia"]');
    if (getGuiaLinks.length > 0) {
      // Use the first one (most recent shipment) — or try to match by guia number
      for (const link of getGuiaLinks) {
        const href = await link.getAttribute('href');
        if (!href) continue;

        // Extract K_Guia from href and check if it matches our guia
        // URL format: /envios/getGuia?K_Oficina=882&K_Guia=2775025
        // Full guia format: 882277502518 → K_Oficina=882, K_Guia=2775025 (partial match)
        const guiaParam = new URLSearchParams(href.split('?')[1] || '').get('K_Guia');
        const oficina = new URLSearchParams(href.split('?')[1] || '').get('K_Oficina');

        logger.info({ guia, href, guiaParam, oficina }, 'Found getGuia link, checking match');

        const fullUrl = `https://www.dac.com.uy${href}`;
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const axios = (await import('axios')).default;

        const response = await axios.get(fullUrl, {
          responseType: 'arraybuffer',
          headers: { Cookie: cookieHeader },
          timeout: 30_000,
        });

        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';

        if (contentType.includes('application/pdf') || buffer.subarray(0, 5).toString() === '%PDF-') {
          fs.writeFileSync(outputPath, buffer);
          logger.info({ guia, path: outputPath, size: buffer.length, href }, 'Label PDF downloaded via getGuia href');
          return outputPath;
        }
      }
    }

    // Strategy 3: Click "Obtener Guia" and wait for download event
    // Last resort if direct fetch didn't work
    const obtenerBtn = await page.$('a:has-text("Obtener Guia")');
    if (obtenerBtn) {
      logger.info({ guia }, 'Trying click-to-download for Obtener Guia');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }),
        obtenerBtn.click(),
      ]);
      await download.saveAs(outputPath);
      logger.info({ guia, path: outputPath }, 'Label downloaded via click event');
      return outputPath;
    }

    const ssPath = await dacBrowser.screenshot(page, `no-guia-link-${guia}`);
    logger.warn({ guia, ssPath }, 'No "Obtener Guia" link found on history page');
    return '';
  } catch (err) {
    const ssPath = await dacBrowser.screenshot(page, `download-error-${guia}`);
    logger.error({ guia, error: (err as Error).message, ssPath }, 'Label download failed');
    return '';
  }
}
