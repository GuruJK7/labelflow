/**
 * Uploads a bulk xlsx to DAC's masivos endpoint and extracts the resulting guias.
 *
 * v2 (2026-04-15): Uses HTTP POST (axios) for the file upload instead of
 * Playwright's setInputFiles which was producing corrupted uploads on Render's
 * Docker. Playwright is only used for login (to get session cookies) and for
 * the post-upload processing (clicking "Cargar envíos" + extracting guias).
 *
 * Flow:
 *   1. Login to DAC via Playwright (reuse cookies)
 *   2. Extract session cookies from the browser
 *   3. POST xlsx via axios multipart/form-data (bypasses Playwright file upload)
 *   4. Navigate browser to masivos page (now shows imported data)
 *   5. Click "Cargar envíos" via Playwright
 *   6. Wait for processing (8 parallel)
 *   7. Extract guias
 */

import { Page } from 'playwright';
import { dacBrowser } from './browser';
import { smartLogin } from './auth';
import logger from '../logger';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';

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
    // 1. Login to DAC via Playwright
    await smartLogin(page, dacUsername, dacPassword, tenantId);
    logger.info('Bulk upload: DAC login successful');

    // 2. Extract cookies from browser session
    const context = page.context();
    const cookies = await context.cookies('https://www.dac.com.uy');
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    logger.info({ cookieCount: cookies.length }, 'Bulk upload: extracted session cookies');

    // 3. Upload xlsx via HTTP POST (axios) — bypasses Playwright file upload issues
    const tmpPath = path.join('/tmp', `bulk_${Date.now()}.xlsx`);
    fs.writeFileSync(tmpPath, xlsxBuffer);

    const form = new FormData();
    form.append('xlsx', fs.createReadStream(tmpPath), {
      filename: 'envios.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const uploadResponse = await axios.post(
      'https://www.dac.com.uy/envios/masivos',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'Cookie': cookieHeader,
          'Referer': 'https://www.dac.com.uy/envios/masivos',
        },
        maxRedirects: 5,
        timeout: 30_000,
        validateStatus: () => true, // don't throw on non-2xx
      },
    );

    fs.unlinkSync(tmpPath);

    const responseBody = typeof uploadResponse.data === 'string'
      ? uploadResponse.data
      : JSON.stringify(uploadResponse.data);

    logger.info({
      status: uploadResponse.status,
      bodyLength: responseBody.length,
      bodyPreview: responseBody.substring(0, 300),
    }, 'Bulk upload: HTTP POST response');

    // Check for error in the response
    if (responseBody.includes('Atención') || responseBody.includes('debe ser numérico')) {
      const errorMatch = responseBody.match(/¡Atención!([^<]+)/);
      return {
        success: false,
        guias: [],
        failedRows: [],
        totalRows: totalExpectedRows,
        error: `DAC validation error: ${errorMatch?.[1]?.trim() || responseBody.substring(0, 200)}`,
      };
    }

    // 4. Navigate browser to masivos page (should now show imported data from the HTTP upload)
    await page.goto('https://www.dac.com.uy/envios/masivos', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    await page.waitForTimeout(2000);

    // Check if data table is showing
    const rowCount = await page.$$eval('tr.rowItem', rows => rows.length);
    logger.info({ rowCount }, 'Bulk upload: checking for imported data table');

    if (rowCount === 0) {
      // The HTTP upload may have created a server-side session with the imported data.
      // If no rows visible, try reloading.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const rowCount2 = await page.$$eval('tr.rowItem', rows => rows.length);
      logger.info({ rowCount: rowCount2 }, 'Bulk upload: after reload');

      if (rowCount2 === 0) {
        return {
          success: false,
          guias: [],
          failedRows: [],
          totalRows: totalExpectedRows,
          error: 'HTTP upload succeeded but no data appeared in the import table. DAC may require browser-based upload.',
        };
      }
    }

    // 5. Click "Cargar envíos"
    const cargarBtn = await page.$('button:has-text("Cargar envíos")');
    if (!cargarBtn) {
      return {
        success: false,
        guias: [],
        failedRows: [],
        totalRows: totalExpectedRows,
        error: '"Cargar envíos" button not found after upload',
      };
    }
    await cargarBtn.click();
    logger.info('Bulk upload: clicked "Cargar envíos"');

    // 6. Wait for processing (8 parallel slots)
    const maxWaitMs = 5 * 60 * 1000;
    const startTime = Date.now();
    let lastLog = 0;

    while (Date.now() - startTime < maxWaitMs) {
      await page.waitForTimeout(2000);
      const spinning = await page.$$eval('tr.rowItem .fa-spinner', els => els.length);
      const completed = await page.$$eval('tr.rowItem .fa-check', els => els.length);
      const failed = await page.$$eval('tr.rowItem .fa-exclamation-triangle', els => els.length);

      if (Date.now() - lastLog > 10_000) {
        logger.info({ spinning, completed, failed }, 'Bulk upload: progress');
        lastLog = Date.now();
      }
      if (spinning === 0) {
        logger.info({ completed, failed }, 'Bulk upload: all rows processed');
        break;
      }
    }

    // 7. Dismiss success dialog
    await page.waitForTimeout(1000);
    const okBtn = await page.$('.alertify-button-ok, .alertify button:has-text("OK")');
    if (okBtn) await okBtn.click();

    // 8. Extract guias
    let guias = await page.$$eval(
      'input[name="Codigo_Rastreo_K_Guia[]"]',
      inputs => inputs.map(i => (i as HTMLInputElement).value).filter(Boolean),
    );

    if (guias.length === 0) {
      guias = await page.$$eval('tr.rowItem', rows =>
        rows.map(row => {
          const m = row.textContent?.match(/\b88\d{10,}\b/);
          return m ? m[0] : '';
        }).filter(Boolean),
      );
    }

    const failedRowIndices = await page.$$eval('tr.rowItem', rows =>
      rows.map((row, idx) => row.querySelector('.fa-exclamation-triangle') ? idx : -1).filter(idx => idx >= 0),
    );

    logger.info({ guias: guias.length, failed: failedRowIndices.length }, 'Bulk upload: done');

    return {
      success: guias.length > 0,
      guias,
      failedRows: failedRowIndices,
      totalRows: totalExpectedRows,
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
