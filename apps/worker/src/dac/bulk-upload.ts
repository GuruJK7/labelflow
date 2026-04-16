/**
 * Bulk upload to DAC via xlsx file upload + Playwright automation.
 *
 * v5 (2026-04-16): Back to xlsx upload (required — DAC's server adds K_Cliente
 * during xlsx parsing, which the API endpoint needs). Uses Playwright's
 * setInputFiles for the simplest possible upload mechanism.
 *
 * Key learning: the /envios/masivos_validateAndUpload API requires server-side
 * enriched data (K_Cliente etc.) that only exists after the xlsx upload step.
 * Direct API calls bypass this and fail with "K_Cliente missing".
 */

import { dacBrowser } from './browser';
import { smartLogin } from './auth';
import logger from '../logger';
import fs from 'fs';
import { BulkXlsxRow } from './bulk-xlsx';

export interface BulkUploadResult {
  success: boolean;
  guias: string[];
  failedRows: number[];
  totalRows: number;
  error?: string;
}

export async function uploadBulkXlsx(
  xlsxBuffer: Buffer,
  dacUsername: string,
  dacPassword: string,
  tenantId: string,
  totalExpectedRows: number,
  _rows?: BulkXlsxRow[],
): Promise<BulkUploadResult> {
  const page = await dacBrowser.getPage();

  try {
    // 1. Login
    await smartLogin(page, dacUsername, dacPassword, tenantId);
    logger.info('Bulk v5: login OK');

    // 2. Navigate to masivos
    await page.goto('https://www.dac.com.uy/envios/masivos', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    await page.waitForTimeout(2000);

    // 3. Save xlsx to temp file
    const tmpPath = `/tmp/bulk_${Date.now()}.xlsx`;
    fs.writeFileSync(tmpPath, xlsxBuffer);
    logger.info({ size: xlsxBuffer.length, path: tmpPath }, 'Bulk v5: xlsx saved');

    // 4. Upload via setInputFiles
    const fileInput = await page.$('input[type="file"][name="xlsx"]');
    if (!fileInput) throw new Error('File input not found');
    await fileInput.setInputFiles(tmpPath);
    logger.info('Bulk v5: file set on input');

    // 5. Click "Subir archivo y validar"
    await page.waitForTimeout(500);
    await page.click('button:has-text("Subir archivo y validar")');
    logger.info('Bulk v5: clicked upload button');

    // 6. Wait for response
    await page.waitForTimeout(5000);

    // Check for error
    const bodyText = await page.textContent('body') ?? '';
    if (bodyText.includes('Atención') && (bodyText.includes('numérico') || bodyText.includes('Error'))) {
      const match = bodyText.match(/Atención[!]?\s*([^¡]+)/);
      const errMsg = match?.[1]?.trim()?.slice(0, 200) || 'Unknown validation error';
      // Dismiss dialog
      await page.click('button:has-text("OK")').catch(() => {});
      fs.unlinkSync(tmpPath);
      return { success: false, guias: [], failedRows: [], totalRows: totalExpectedRows, error: errMsg };
    }

    // 7. Check for data table
    const rowCount = await page.$$eval('tr.rowItem', r => r.length).catch(() => 0);
    logger.info({ rowCount }, 'Bulk v5: rows imported');

    if (rowCount === 0) {
      fs.unlinkSync(tmpPath);
      return { success: false, guias: [], failedRows: [], totalRows: totalExpectedRows, error: 'No rows in import table' };
    }

    // 8. Click "Cargar envíos"
    await page.click('button:has-text("Cargar envíos")');
    logger.info('Bulk v5: processing started');

    // 9. Wait for all rows to process (max 5 min)
    const maxWait = 5 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await page.waitForTimeout(3000);
      const spinning = await page.$$eval('.fa-spinner', e => e.length).catch(() => 0);
      if (spinning === 0) break;
    }

    // 10. Dismiss success dialog
    await page.waitForTimeout(1000);
    await page.click('button:has-text("OK")').catch(() => {});

    // 11. Extract guias
    let guias = await page.$$eval(
      'input[name="Codigo_Rastreo_K_Guia[]"]',
      inputs => inputs.map(i => (i as HTMLInputElement).value).filter(Boolean),
    ).catch(() => [] as string[]);

    if (guias.length === 0) {
      guias = await page.$$eval('tr.rowItem', rows =>
        rows.map(r => (r.textContent?.match(/\b88\d{10,}\b/) || [])[0] || '').filter(Boolean),
      ).catch(() => [] as string[]);
    }

    const failed = await page.$$eval('tr.rowItem', rows =>
      rows.map((r, i) => r.querySelector('.fa-exclamation-triangle') ? i : -1).filter(i => i >= 0),
    ).catch(() => [] as number[]);

    fs.unlinkSync(tmpPath);
    logger.info({ guias: guias.length, failed: failed.length }, 'Bulk v5: done');

    return { success: guias.length > 0, guias, failedRows: failed, totalRows: totalExpectedRows };
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Bulk v5: error');
    return { success: false, guias: [], failedRows: [], totalRows: totalExpectedRows, error: (err as Error).message };
  }
}
