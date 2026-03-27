import { Page } from 'playwright';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import logger from '../logger';
import fs from 'fs';
import path from 'path';

/**
 * Downloads a shipping label PDF from DAC's history/cart page.
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

  // Navigate to history/cart page
  await page.goto(DAC_URLS.HISTORY, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Try to find and click download button
  try {
    const downloadSelectors = DAC_SELECTORS.DOWNLOAD_LABEL.split(',').map((s: string) => s.trim());

    for (const selector of downloadSelectors) {
      const el = await page.$(selector);
      if (el) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 10_000 }),
          page.click(selector),
        ]);

        await download.saveAs(outputPath);
        logger.info({ guia, path: outputPath }, 'Label downloaded');
        return outputPath;
      }
    }

    // Fallback: look for PDF link in page
    const pdfUrl = await page.evaluate((): string | null => {
      const links = Array.from(document.querySelectorAll('a'));
      const pdfLink = links.find((a) => a.href.includes('.pdf') || a.href.includes('etiqueta'));
      return pdfLink?.href ?? null;
    });

    if (pdfUrl) {
      const cookies = await page.context().cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const axios = (await import('axios')).default;
      const response = await axios.get(pdfUrl, {
        responseType: 'arraybuffer',
        headers: { Cookie: cookieHeader },
      });
      fs.writeFileSync(outputPath, response.data);
      logger.info({ guia, path: outputPath }, 'Label downloaded via URL fallback');
      return outputPath;
    }

    logger.warn({ guia }, 'No download button found, label may need manual download');
    return '';
  } catch (err) {
    const ssPath = await dacBrowser.screenshot(page, `download-error-${guia}`);
    logger.error({ guia, error: (err as Error).message, ssPath }, 'Label download failed');
    return '';
  }
}
