import { Page } from 'playwright';
import { DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import logger from '../logger';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Downloads a shipping label PDF ("Obtener Guia") from DAC's history page.
 *
 * DAC historial table structure — each row (<tr>) contains:
 *   - "Rastrear envío"    → /envios/rastreo/Codigo_Rastreo/{fullGuia}        (has FULL guia in URL)
 *   - "Reenviar Guia"     → javascript:;
 *   - "Obtener Guia"      → /envios/getGuia?K_Oficina=XXX&K_Guia=XXXXXXX    ← THE PDF
 *   - "Imprimir etiqueta" → /envios/getPegote?CodigoRastreo={fullGuia}
 *
 * Matching strategy: Find the <tr> that contains a "Rastrear envío" link with the
 * full guia in its href (e.g. /envios/rastreo/Codigo_Rastreo/882277502518),
 * then get the "Obtener Guia" href from that same row.
 *
 * IMPORTANT: Do NOT use generic selectors like a[href*=".pdf"] — the navbar has
 * a "Horarios Turismo" PDF link that would match instead.
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

  // Navigate to history page
  await page.goto(DAC_URLS.HISTORY, { waitUntil: 'networkidle' });

  // Wait for the table to load — look for any getGuia link as signal
  try {
    await page.waitForSelector('a[href*="/envios/getGuia"]', { timeout: 10_000 });
  } catch {
    // Table might be empty or loading slow — try with full content
    await page.waitForTimeout(3000);
  }

  try {
    // ── Find the correct "Obtener Guia" href for THIS guia ──
    // We search for the <tr> that has a link containing our guia number,
    // then extract the getGuia URL from that same row.
    const getGuiaHref = await page.evaluate((targetGuia: string) => {
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const links = Array.from(row.querySelectorAll('a'));
        let hasMatchingGuia = false;
        let guiaHref: string | null = null;

        for (const link of links) {
          const href = link.getAttribute('href') || '';
          // Check if this row's tracking link contains our full guia
          // Links: /envios/rastreo/Codigo_Rastreo/882277502518
          //    or: /envios/getPegote?CodigoRastreo=882277502518
          if (href.includes(targetGuia)) {
            hasMatchingGuia = true;
          }
          // Capture the getGuia link from this row
          if (href.includes('/envios/getGuia')) {
            guiaHref = href;
          }
        }

        if (hasMatchingGuia && guiaHref) {
          return guiaHref;
        }
      }
      return null;
    }, guia);

    if (getGuiaHref) {
      logger.info({ guia, href: getGuiaHref }, 'Found matching Obtener Guia link for this guia');

      const fullUrl = `https://www.dac.com.uy${getGuiaHref}`;
      const cookies = await page.context().cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      const response = await axios.get(fullUrl, {
        responseType: 'arraybuffer',
        headers: { Cookie: cookieHeader },
        timeout: 30_000,
      });

      const buffer = Buffer.from(response.data);
      const contentType = response.headers['content-type'] || '';
      const isPdf = contentType.includes('application/pdf') ||
        (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46); // %PDF

      if (isPdf) {
        fs.writeFileSync(outputPath, buffer);
        logger.info({ guia, path: outputPath, size: buffer.length }, 'Label PDF downloaded successfully');
        return outputPath;
      } else {
        logger.warn({ guia, contentType, size: buffer.length }, 'Obtener Guia returned non-PDF content');
      }
    } else {
      logger.warn({ guia }, 'No matching row found for this guia on the history page');
    }

    // ── Fallback: if only one row exists, use its "Obtener Guia" link ──
    // This covers the case right after creating a shipment (only 1 pending)
    const allGetGuiaLinks = await page.$$('a[href*="/envios/getGuia"]');
    if (allGetGuiaLinks.length === 1) {
      const href = await allGetGuiaLinks[0].getAttribute('href');
      if (href) {
        logger.info({ guia, href }, 'Single getGuia link on page — using it as fallback');

        const fullUrl = `https://www.dac.com.uy${href}`;
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

        const response = await axios.get(fullUrl, {
          responseType: 'arraybuffer',
          headers: { Cookie: cookieHeader },
          timeout: 30_000,
        });

        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';
        const isPdf = contentType.includes('application/pdf') ||
          (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46);

        if (isPdf) {
          fs.writeFileSync(outputPath, buffer);
          logger.info({ guia, path: outputPath, size: buffer.length }, 'Label PDF downloaded via single-link fallback');
          return outputPath;
        }
      }
    }

    // ── Fallback: click-to-download (handles JS-generated PDFs) ──
    const matchedLink = getGuiaHref
      ? await page.$(`a[href="${getGuiaHref}"]`)
      : allGetGuiaLinks.length === 1
        ? allGetGuiaLinks[0]
        : null;

    if (matchedLink) {
      logger.info({ guia }, 'Trying click-to-download as last resort');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }),
        matchedLink.click(),
      ]);
      await download.saveAs(outputPath);
      logger.info({ guia, path: outputPath }, 'Label downloaded via click event');
      return outputPath;
    }

    const ssPath = await dacBrowser.screenshot(page, `no-guia-link-${guia}`);
    logger.warn({ guia, ssPath }, 'No "Obtener Guia" link found for this guia');
    return '';
  } catch (err) {
    const ssPath = await dacBrowser.screenshot(page, `download-error-${guia}`);
    logger.error({ guia, error: (err as Error).message, ssPath }, 'Label download failed');
    return '';
  }
}
