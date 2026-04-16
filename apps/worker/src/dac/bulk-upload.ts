/**
 * Bulk upload to DAC via xlsx file upload + Playwright automation.
 *
 * v6 (2026-04-16): Key fix — xlsx MUST have a HEADER ROW (row 1) + DATA ROWS
 * (row 2+). Without headers, DAC treats the first data row as headers and
 * returns 0 data rows. Also uses simple 10-column layout (same as manual test)
 * and passes buffer directly to setInputFiles (bypasses Docker filesystem).
 */

import { dacBrowser } from './browser';
import { smartLogin } from './auth';
import logger from '../logger';
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
    logger.info('Bulk v6: login OK');

    // 2. Navigate to masivos
    await page.goto('https://www.dac.com.uy/envios/masivos', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    await page.waitForTimeout(2000);

    // 3. Upload xlsx via buffer (bypass filesystem)
    const fileInput = await page.$('input[type="file"][name="xlsx"]');
    if (!fileInput) throw new Error('File input not found');
    await fileInput.setInputFiles({
      name: 'envios.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: xlsxBuffer,
    });
    logger.info({ size: xlsxBuffer.length }, 'Bulk v6: file set');

    // 4. Disable validationEngine (blocks Playwright-set files) then click
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      // Detach validation engine so it doesn't block the submit
      const $form = (window as any).$('#formUploadXlsx');
      if ($form.length) {
        try { $form.validationEngine('detach'); } catch {}
      }
    });
    await page.click('#btnDoUpload, button:has-text("Subir archivo y validar")');
    logger.info('Bulk v6: clicked upload (validation detached)');

    // 5. Wait for DAC's AJAX to complete and table to render
    //    DAC shows either an error dialog or the data table
    await page.waitForTimeout(10000);
    const rowCount = await page.$$eval('tr.rowItem', r => r.length).catch(() => 0);
    logger.info({ rowCount }, 'Bulk v6: rows in table');

    if (rowCount === 0) {
      return { success: false, guias: [], failedRows: [], totalRows: totalExpectedRows,
        error: 'No data rows after upload' };
    }

    // 6. Click "Cargar envíos"
    await page.click('.btnCargar').catch(() => page.click('button:has-text("Cargar envíos")'));
    logger.info('Bulk v6: processing');

    // 7. Wait for processing (max 5 min)
    const maxWait = 5 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await page.waitForTimeout(3000);
      const spinning = await page.$$eval('.fa-spinner', e => e.length).catch(() => 0);
      if (spinning === 0) break;
    }

    // 8. Dismiss dialog
    await page.waitForTimeout(1000);
    await page.click('button:has-text("OK")').catch(() => {});

    // 9. Extract guias
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

    logger.info({ guias: guias.length, failed: failed.length }, 'Bulk v6: done');
    return { success: guias.length > 0, guias, failedRows: failed, totalRows: totalExpectedRows };
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Bulk v6: error');
    return { success: false, guias: [], failedRows: [], totalRows: totalExpectedRows, error: (err as Error).message };
  }
}
