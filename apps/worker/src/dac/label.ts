import { Page } from 'playwright';
import { DAC, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import logger from '../logger';
import fs from 'fs';
import path from 'path';

/**
 * Downloads a shipping label PDF from DAC's tracking page.
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

  // Navigate to tracking page
  await page.goto(DAC_URLS.TRACK, { waitUntil: 'networkidle' });

  // Fill tracking number
  await page.fill(DAC.tracking.searchInput, guia);

  // Click search (type="button", JS onclick)
  await page.click(DAC.tracking.searchButton);
  await page.waitForLoadState('networkidle');

  // Try to download the label PDF
  try {
    const downloadSelectors = DAC.tracking.downloadButton.split(',').map((s: string) => s.trim());

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

    throw new Error('No download button or PDF link found');
  } catch (err) {
    const ssPath = await dacBrowser.screenshot(page, `download-error-${guia}`);
    throw new Error(`Label download failed for guia ${guia}: ${(err as Error).message}. Screenshot: ${ssPath}`);
  }
}
