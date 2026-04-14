/**
 * Uploads a bulk xlsx to DAC's masivos endpoint and extracts the resulting guias.
 *
 * Uses Playwright ONLY for the upload + button clicks + guia extraction.
 * The heavy lifting (form filling, geocoding, step navigation) is done by DAC
 * server-side, not by our Playwright code. This reduces browser time from
 * ~2-3 min per order (individual form fill) to ~5 sec per order (8x parallel
 * server-side processing).
 *
 * Flow:
 *   1. Login to DAC (reuse existing cookies if possible)
 *   2. Navigate to /envios/masivos
 *   3. Upload the xlsx file via the file input
 *   4. Click "Subir archivo y validar"
 *   5. Wait for the import table to appear
 *   6. Click "Cargar envíos"
 *   7. Wait for all rows to process (DAC processes 8 in parallel)
 *   8. Extract guias from the processed rows
 *   9. Return the guia list
 */

import { Page } from 'playwright';
import { dacBrowser } from './browser';
import { smartLogin } from './auth';
import logger from '../logger';
import fs from 'fs';
import path from 'path';

export interface BulkUploadResult {
  success: boolean;
  guias: string[];
  failedRows: number[];
  totalRows: number;
  error?: string;
}

/**
 * Upload a bulk xlsx to DAC and return the generated guias.
 *
 * @param xlsxBuffer - The xlsx file content as a Buffer
 * @param dacUsername - DAC login username (CI/RUT)
 * @param dacPassword - DAC login password
 * @param tenantId - Tenant ID for cookie management
 * @param totalExpectedRows - How many rows are in the xlsx (for progress tracking)
 */
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
    logger.info('Bulk upload: DAC login successful');

    // 2. Navigate to masivos page
    await page.goto('https://www.dac.com.uy/envios/masivos', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    await page.waitForTimeout(2000);

    // 3. Write xlsx to a temp file for upload
    const tmpPath = path.join('/tmp', `bulk_${Date.now()}.xlsx`);
    fs.writeFileSync(tmpPath, xlsxBuffer);

    // 4. Upload the file
    const fileInput = await page.$('input[type="file"][name="xlsx"]');
    if (!fileInput) {
      throw new Error('File input not found on masivos page');
    }
    await fileInput.setInputFiles(tmpPath);
    logger.info({ tmpPath, size: xlsxBuffer.length }, 'Bulk upload: file set on input');

    // 5. Click "Subir archivo y validar"
    const uploadBtn = await page.$('button:has-text("Subir archivo y validar")');
    if (!uploadBtn) {
      throw new Error('"Subir archivo y validar" button not found');
    }
    await uploadBtn.click();
    logger.info('Bulk upload: clicked "Subir archivo y validar"');

    // 6. Wait for import table or error dialog
    await page.waitForTimeout(3000);

    // Check for error dialog
    const errorDialog = await page.$('.alertify-dialog, .alertify');
    if (errorDialog) {
      const errorText = await errorDialog.textContent();
      if (errorText?.includes('Atención') || errorText?.includes('Error')) {
        // Click OK to dismiss
        const okBtn = await page.$('.alertify-button-ok, .alertify button');
        if (okBtn) await okBtn.click();
        // Clean up temp file
        fs.unlinkSync(tmpPath);
        return {
          success: false,
          guias: [],
          failedRows: [],
          totalRows: totalExpectedRows,
          error: `DAC validation error: ${errorText?.trim().slice(0, 200)}`,
        };
      }
    }

    // 7. Wait for the "Datos importados" section to show data
    await page.waitForSelector('tr.rowItem', { timeout: 10_000 }).catch(() => {});
    const rowCount = await page.$$eval('tr.rowItem', rows => rows.length);
    logger.info({ rowCount, expected: totalExpectedRows }, 'Bulk upload: import table loaded');

    if (rowCount === 0) {
      fs.unlinkSync(tmpPath);
      return {
        success: false,
        guias: [],
        failedRows: [],
        totalRows: totalExpectedRows,
        error: 'No rows imported from xlsx',
      };
    }

    // 8. Click "Cargar envíos" to start processing
    const cargarBtn = await page.$('button:has-text("Cargar envíos")');
    if (!cargarBtn) {
      throw new Error('"Cargar envíos" button not found');
    }
    await cargarBtn.click();
    logger.info('Bulk upload: clicked "Cargar envíos", waiting for processing...');

    // 9. Wait for all rows to process (DAC does 8 in parallel)
    // Poll until no more spinning icons remain (or timeout after 5 min)
    const maxWaitMs = 5 * 60 * 1000;
    const startTime = Date.now();
    let lastLog = 0;

    while (Date.now() - startTime < maxWaitMs) {
      await page.waitForTimeout(2000);

      // Count completed vs still processing
      const spinning = await page.$$eval('tr.rowItem .fa-spinner', els => els.length);
      const completed = await page.$$eval('tr.rowItem .fa-check', els => els.length);
      const failed = await page.$$eval('tr.rowItem .fa-exclamation-triangle', els => els.length);

      if (Date.now() - lastLog > 10_000) {
        logger.info({ spinning, completed, failed, elapsed: Math.round((Date.now() - startTime) / 1000) },
          'Bulk upload: processing progress');
        lastLog = Date.now();
      }

      if (spinning === 0) {
        logger.info({ completed, failed, elapsed: Math.round((Date.now() - startTime) / 1000) },
          'Bulk upload: all rows processed');
        break;
      }
    }

    // 10. Check for success dialog
    await page.waitForTimeout(1000);
    const successDialog = await page.textContent('.alertify-dialog, .alertify').catch(() => '');
    if (successDialog?.includes('Felicitaciones')) {
      // Dismiss
      const okBtn = await page.$('.alertify-button-ok, .alertify button:has-text("OK")');
      if (okBtn) await okBtn.click();
      await page.waitForTimeout(500);
    }

    // 11. Extract guias from the page
    // After processing, each successful row has a hidden input with the guia
    const guias = await page.$$eval(
      'input[name="Codigo_Rastreo_K_Guia[]"]',
      inputs => inputs.map(i => (i as HTMLInputElement).value).filter(Boolean),
    );

    // If no hidden inputs, try extracting from table cell text
    let finalGuias = guias;
    if (finalGuias.length === 0) {
      finalGuias = await page.$$eval('tr.rowItem', rows => {
        return rows.map(row => {
          const text = row.textContent ?? '';
          const guiaMatch = text.match(/\b88\d{10,}\b/);
          return guiaMatch ? guiaMatch[0] : '';
        }).filter(Boolean);
      });
    }

    // 12. Identify failed rows
    const failedRowIndices = await page.$$eval('tr.rowItem', rows => {
      return rows.map((row, idx) => {
        const hasError = row.querySelector('.fa-exclamation-triangle');
        return hasError ? idx : -1;
      }).filter(idx => idx >= 0);
    });

    // Clean up temp file
    fs.unlinkSync(tmpPath);

    logger.info({
      guias: finalGuias.length,
      failedRows: failedRowIndices.length,
      totalRows: rowCount,
    }, 'Bulk upload: extraction complete');

    return {
      success: finalGuias.length > 0,
      guias: finalGuias,
      failedRows: failedRowIndices,
      totalRows: rowCount,
    };
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Bulk upload failed');
    return {
      success: false,
      guias: [],
      failedRows: [],
      totalRows: totalExpectedRows,
      error: (err as Error).message,
    };
  }
}
