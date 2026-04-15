/**
 * Uploads a bulk xlsx to DAC's masivos endpoint and extracts the resulting guias.
 *
 * v3 (2026-04-15): Injects the xlsx file directly into the browser via
 * JavaScript (DataTransfer + File API) instead of setInputFiles or HTTP POST.
 * This keeps everything in one browser session and avoids the Render Docker
 * file upload issues.
 */

import { dacBrowser } from './browser';
import { smartLogin } from './auth';
import logger from '../logger';

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
): Promise<BulkUploadResult> {
  const page = await dacBrowser.getPage();

  try {
    // 1. Login
    await smartLogin(page, dacUsername, dacPassword, tenantId);
    logger.info('Bulk upload: DAC login OK');

    // 2. Navigate to masivos
    await page.goto('https://www.dac.com.uy/envios/masivos', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    await page.waitForTimeout(2000);

    // 3. Inject xlsx file into the file input via JavaScript
    //    This avoids both setInputFiles (broken on Docker) and HTTP POST
    //    (session mismatch). The File is created in-browser from base64 data.
    const base64 = xlsxBuffer.toString('base64');

    await page.evaluate((b64: string) => {
      const binaryStr = atob(b64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const file = new File(
        [bytes],
        'envios.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      );
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('input[type="file"][name="xlsx"]') as HTMLInputElement;
      if (!input) throw new Error('File input not found');
      input.files = dt.files;
      // Trigger change event so DAC's JS picks up the file
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, base64);

    logger.info({ size: xlsxBuffer.length, base64Length: base64.length }, 'Bulk upload: file injected into input');

    // 4. Click "Subir archivo y validar"
    await page.waitForTimeout(500);
    const uploadBtn = await page.$('button:has-text("Subir archivo y validar")');
    if (!uploadBtn) {
      throw new Error('"Subir archivo y validar" button not found');
    }
    await uploadBtn.click();
    logger.info('Bulk upload: clicked "Subir archivo y validar"');

    // 5. Wait for response (could be error dialog or data table)
    await page.waitForTimeout(5000);

    // Check for error dialog
    const pageText = await page.textContent('body') ?? '';
    if (pageText.includes('Atención') && pageText.includes('numérico')) {
      const errorMatch = pageText.match(/¡Atención!([^¡]+)/);
      // Dismiss dialog
      const okBtn = await page.$('.alertify-button-ok, button:has-text("OK")');
      if (okBtn) await okBtn.click();
      return {
        success: false,
        guias: [],
        failedRows: [],
        totalRows: totalExpectedRows,
        error: `DAC validation error: ${errorMatch?.[1]?.trim().slice(0, 200) || 'unknown'}`,
      };
    }

    // 6. Check for imported data table
    const rowCount = await page.$$eval('tr.rowItem', rows => rows.length);
    logger.info({ rowCount }, 'Bulk upload: data table rows');

    if (rowCount === 0) {
      return {
        success: false,
        guias: [],
        failedRows: [],
        totalRows: totalExpectedRows,
        error: 'No rows appeared in import table after upload',
      };
    }

    // 7. Click "Cargar envíos"
    const cargarBtn = await page.$('button:has-text("Cargar envíos")');
    if (!cargarBtn) {
      return {
        success: false,
        guias: [],
        failedRows: [],
        totalRows: totalExpectedRows,
        error: '"Cargar envíos" button not found',
      };
    }
    await cargarBtn.click();
    logger.info('Bulk upload: clicked "Cargar envíos"');

    // 8. Wait for processing (8 parallel slots, max 5 min)
    const maxWaitMs = 5 * 60 * 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await page.waitForTimeout(3000);
      const spinning = await page.$$eval('.fa-spinner', els => els.length);
      const completed = await page.$$eval('.fa-check', els => els.length);
      const failed = await page.$$eval('.fa-exclamation-triangle', els => els.length);
      logger.info({ spinning, completed, failed }, 'Bulk upload: progress');
      if (spinning === 0) break;
    }

    // 9. Dismiss success dialog
    await page.waitForTimeout(1000);
    const okBtn = await page.$('button:has-text("OK")');
    if (okBtn) await okBtn.click();

    // 10. Extract guias
    let guias = await page.$$eval(
      'input[name="Codigo_Rastreo_K_Guia[]"]',
      inputs => inputs.map(i => (i as HTMLInputElement).value).filter(Boolean),
    );
    if (guias.length === 0) {
      guias = await page.$$eval('tr.rowItem', rows =>
        rows.map(row => (row.textContent?.match(/\b88\d{10,}\b/) || [])[0] || '').filter(Boolean),
      );
    }

    const failedRowIndices = await page.$$eval('tr.rowItem', rows =>
      rows.map((row, idx) => row.querySelector('.fa-exclamation-triangle') ? idx : -1).filter(i => i >= 0),
    );

    logger.info({ guias: guias.length, failed: failedRowIndices.length }, 'Bulk upload: complete');

    return { success: guias.length > 0, guias, failedRows: failedRowIndices, totalRows: totalExpectedRows };
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Bulk upload failed');
    return { success: false, guias: [], failedRows: [], totalRows: totalExpectedRows, error: (err as Error).message };
  }
}
