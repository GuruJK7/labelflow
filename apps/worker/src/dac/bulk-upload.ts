/**
 * Bulk upload to DAC via direct API calls to /envios/masivos_validateAndUpload.
 *
 * v4 (2026-04-15): Bypasses the xlsx upload entirely. Instead of generating
 * a spreadsheet and uploading it through the browser, we call DAC's internal
 * per-row validation endpoint directly via HTTP.
 *
 * Discovery: reading envios.masivos.js revealed that the xlsx upload is just
 * a UI wrapper. After the user uploads an xlsx, DAC's JS extracts each row's
 * cell values as strings and POSTs them as {items: [...]} to the endpoint.
 * The server validates, geocodes, and creates the guia.
 *
 * Response format: {data: {response: {WS_InGuiaResponse: {WS_InGuia: {K_Guia: "882279..."}}}}}
 *
 * This approach eliminates ALL xlsx format issues (column count, types, order)
 * because we send the same data the browser JS would extract from the table.
 */

import { dacBrowser } from './browser';
import { smartLogin } from './auth';
import logger from '../logger';
import axios from 'axios';
import { BulkXlsxRow } from './bulk-xlsx';

export interface BulkUploadResult {
  success: boolean;
  guias: string[];
  failedRows: number[];
  totalRows: number;
  error?: string;
}

const PARALLEL_SLOTS = 8; // DAC processes 8 in parallel (from masivos JS: hilos = 8)

/**
 * Build the items array for a single order. The order of items must match
 * what DAC expects when processing rows from the masivos table.
 *
 * We'll discover the correct order by testing. Starting with the same
 * 10-item layout that worked with the all-1s manual test.
 */
function buildItems(row: BulkXlsxRow): string[] {
  return [
    String(row.nombre),
    String(row.telefono),
    String(row.direccion),
    String(row.kEstado),
    String(row.kCiudad),
    String(row.oficina),
    String(row.observaciones),
    String(row.email),
    String(row.empaque),
    String(row.cantidad),
  ];
}

/**
 * Process a single order via DAC's masivos API.
 * Returns the guia string on success, or null on failure.
 */
async function processOneOrder(
  items: string[],
  cookieHeader: string,
  orderName: string,
): Promise<{ guia: string | null; error?: string }> {
  try {
    const response = await axios.post(
      'https://www.dac.com.uy/envios/masivos_validateAndUpload',
      { items },
      {
        headers: {
          'Cookie': cookieHeader,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.dac.com.uy/envios/masivos',
        },
        timeout: 30_000,
        validateStatus: () => true,
      },
    );

    const data = response.data;

    // Success path: extract guia from WS response
    const guia = data?.data?.response?.WS_InGuiaResponse?.WS_InGuia?.K_Guia;
    if (guia) {
      logger.info({ orderName, guia }, 'Bulk API: guia created');
      return { guia: String(guia) };
    }

    // Error path
    const errorMsg = data?.msg || data?.message || JSON.stringify(data).slice(0, 200);
    logger.warn({ orderName, error: errorMsg }, 'Bulk API: order failed');
    return { guia: null, error: errorMsg };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ orderName, error: msg }, 'Bulk API: request failed');
    return { guia: null, error: msg };
  }
}

/**
 * Process all orders via DAC's masivos API with 8-way parallelism.
 */
export async function uploadBulkXlsx(
  _xlsxBuffer: Buffer, // kept for interface compat, not used in v4
  dacUsername: string,
  dacPassword: string,
  tenantId: string,
  totalExpectedRows: number,
  rows?: BulkXlsxRow[], // the actual row data to send
): Promise<BulkUploadResult> {
  if (!rows || rows.length === 0) {
    return { success: false, guias: [], failedRows: [], totalRows: 0, error: 'No rows provided' };
  }

  const page = await dacBrowser.getPage();

  try {
    // 1. Login to DAC via Playwright to get session cookies
    await smartLogin(page, dacUsername, dacPassword, tenantId);
    logger.info('Bulk API: DAC login OK');

    // 2. Extract cookies
    const context = page.context();
    const cookies = await context.cookies('https://www.dac.com.uy');
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    logger.info({ cookieCount: cookies.length }, 'Bulk API: cookies extracted');

    // 3. Process orders in parallel batches of 8
    const guias: string[] = [];
    const failedRows: number[] = [];

    for (let i = 0; i < rows.length; i += PARALLEL_SLOTS) {
      const batch = rows.slice(i, i + PARALLEL_SLOTS);
      const promises = batch.map((row, batchIdx) => {
        const items = buildItems(row);
        return processOneOrder(items, cookieHeader, row.orderName).then(result => ({
          globalIdx: i + batchIdx,
          ...result,
        }));
      });

      const results = await Promise.all(promises);

      for (const r of results) {
        if (r.guia) {
          guias.push(r.guia);
        } else {
          failedRows.push(r.globalIdx);
          logger.warn({ idx: r.globalIdx, order: rows[r.globalIdx]?.orderName, error: r.error },
            'Bulk API: row failed');
        }
      }

      logger.info({
        batchStart: i,
        batchEnd: Math.min(i + PARALLEL_SLOTS, rows.length),
        guiasSoFar: guias.length,
        failedSoFar: failedRows.length,
      }, 'Bulk API: batch complete');
    }

    logger.info({ total: rows.length, guias: guias.length, failed: failedRows.length },
      'Bulk API: all batches complete');

    return {
      success: guias.length > 0,
      guias,
      failedRows,
      totalRows: rows.length,
    };
  } catch (err) {
    logger.error({ error: (err as Error).message }, 'Bulk API: fatal error');
    return {
      success: false,
      guias: [],
      failedRows: [],
      totalRows: totalExpectedRows,
      error: (err as Error).message,
    };
  }
}
