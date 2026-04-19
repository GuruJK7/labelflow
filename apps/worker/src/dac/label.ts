import { Page } from 'playwright';
import { DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import logger from '../logger';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Downloads the shipping label sticker PDF ("Imprimir etiqueta") from DAC.
 *
 * DAC has two PDF types per shipment:
 *   - "Obtener Guia"      → /envios/getGuia?K_Oficina=XXX&K_Guia=XXXXXXX
 *     → Receipt/invoice (COMPROBANTE DE ENVIO) — NOT what we want
 *   - "Imprimir etiqueta" → /envios/getPegote?CodigoRastreo={fullGuia}
 *     → Shipping label sticker with barcode, QR, destination — THIS is what we want
 *
 * The getPegote URL is deterministic: we just need the full guia (CodigoRastreo).
 * No HTML parsing needed.
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

  logger.info({ guia, outputDir }, 'Downloading shipping label (pegote) from DAC');

  // DAC occasionally needs time after shipment creation to make the pegote PDF
  // available (returns HTTP 500 until then). Retry with backoff.
  // Observed in prod: 21s window was insufficient for some guias (e.g. 2355997).
  // Extended to ~110s total window covering 5 attempts.
  const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

  try {
    // The label sticker URL is deterministic — no need to navigate to history page
    const labelUrl = `https://www.dac.com.uy/envios/getPegote?CodigoRastreo=${guia}`;

    // We need an authenticated session — ensure we're logged in first,
    // then grab cookies from the browser context
    await page.goto(DAC_URLS.HISTORY, { waitUntil: 'networkidle' });
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    logger.info({ guia, url: labelUrl }, 'Fetching label PDF via getPegote');

    // Attempt up to 4 times total: initial + 3 retries. Retry on 5xx and on
    // non-PDF responses (DAC sometimes returns HTML "envio no encontrado" while
    // indexing). 4xx errors are NOT retried — those are unrecoverable.
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await axios.get(labelUrl, {
          responseType: 'arraybuffer',
          headers: { Cookie: cookieHeader },
          timeout: 30_000,
          validateStatus: () => true, // handle status codes manually so we control retries
        });

        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || '';
        const isPdf = contentType.includes('application/pdf') ||
          (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46); // %PDF

        if (response.status === 200 && isPdf && buffer.length > 1000) {
          fs.writeFileSync(outputPath, buffer);
          logger.info({ guia, path: outputPath, size: buffer.length, attempt: attempt + 1 }, 'Shipping label PDF downloaded successfully');
          return outputPath;
        }

        const retriable = response.status >= 500 || !isPdf;
        if (!retriable || response.status >= 400 && response.status < 500) {
          logger.warn({ guia, status: response.status, contentType, size: buffer.length }, 'getPegote returned non-retriable response');
          break;
        }
        logger.warn({ guia, status: response.status, contentType, size: buffer.length, attempt: attempt + 1 }, 'getPegote returned retriable response');
      } catch (innerErr) {
        lastErr = innerErr as Error;
        logger.warn({ guia, error: lastErr.message, attempt: attempt + 1 }, 'getPegote request threw — will retry if attempts remain');
      }

      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger.info({ guia, delayMs: delay, nextAttempt: attempt + 2 }, 'Sleeping before pegote retry');
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // All HTTP retries exhausted — try the UI fallback (click the "Imprimir
    // etiqueta" link). By now DAC has had ~110s total to index the shipment.
    const etiquetaLink = await page.$(`a[href*="getPegote"][href*="${guia}"]`);
    if (etiquetaLink) {
      logger.info({ guia }, 'Trying click-to-download fallback for Imprimir etiqueta');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }),
        etiquetaLink.click(),
      ]);
      await download.saveAs(outputPath);
      logger.info({ guia, path: outputPath }, 'Label downloaded via click event');
      return outputPath;
    }

    const ssPath = await dacBrowser.screenshot(page, `label-not-found-${guia}`);
    logger.warn({ guia, ssPath, lastErr: lastErr?.message }, 'Could not download shipping label after retries');
    return '';
  } catch (err) {
    const ssPath = await dacBrowser.screenshot(page, `download-error-${guia}`);
    logger.error({ guia, error: (err as Error).message, ssPath }, 'Label download failed');
    return '';
  }
}
