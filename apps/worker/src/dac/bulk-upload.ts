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
  // DAC's masivos JS extracts items from table cells via $('td span').each().
  // The FIRST span is the status button span (contains " " / &nbsp;), followed
  // by the actual data column spans. So items[0] = " " and items[1..N] = data.
  //
  // For the 10-column xlsx format that worked manually, the items are:
  //   [0] = " " (button span)
  //   [1] = nombre
  //   [2] = telefono
  //   [3] = direccion
  //   [4] = K_Estado
  //   [5] = K_Ciudad
  //   [6] = Oficina_destino
  //   [7] = observaciones
  //   [8] = email
  //   [9] = K_Tipo_Empaque
  //   [10] = cantidad
  return [
    ' ',                       // [0] status span (empty/nbsp)
    String(row.nombre),        // [1] nombre
    String(row.telefono),      // [2] telefono
    String(row.direccion),     // [3] direccion
    String(row.kEstado),       // [4] K_Estado (dept ID)
    String(row.kCiudad),       // [5] K_Ciudad (city ID)
    String(row.oficina),       // [6] Oficina_destino (office ID)
    String(row.observaciones), // [7] observaciones
    String(row.email),         // [8] email
    String(row.empaque),       // [9] K_Tipo_Empaque
    String(row.cantidad),      // [10] cantidad
  ];
}

/**
 * Process a single order using DAC's OWN InitiateAsyncAjaxCall function
 * executed INSIDE the browser via page.evaluate. This guarantees the request
 * matches what DAC's JavaScript sends — same jQuery serialization, same
 * cookies, same CSRF tokens, same everything.
 */
async function processOneOrderInBrowser(
  page: import('playwright').Page,
  items: string[],
  orderName: string,
): Promise<{ guia: string | null; error?: string }> {
  try {
    const result = await page.evaluate(async (itemsArg: string[]) => {
      return new Promise<{ ok: boolean; guia?: string; error?: string }>((resolve) => {
        // Use DAC's own AJAX function (loaded on the masivos page)
        (window as any).InitiateAsyncAjaxCall(
          '/envios/masivos_validateAndUpload',
          { items: itemsArg },
          (data: any) => {
            const guia = data?.data?.response?.WS_InGuiaResponse?.WS_InGuia?.K_Guia;
            resolve({ ok: true, guia: String(guia || '') });
          },
          (data: any) => {
            resolve({ ok: false, error: data?.msg || 'Unknown error' });
          },
          (_jqXHR: any, textStatus: string) => {
            resolve({ ok: false, error: `Request failed: ${textStatus}` });
          },
        );
      });
    }, items);

    if (result.ok && result.guia) {
      logger.info({ orderName, guia: result.guia }, 'Bulk API: guia created');
      return { guia: result.guia };
    }
    return { guia: null, error: result.error };
  } catch (err) {
    return { guia: null, error: (err as Error).message };
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

    // 2. Navigate to masivos page (required: InitiateAsyncAjaxCall is loaded here)
    await page.goto('https://www.dac.com.uy/envios/masivos', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    await page.waitForTimeout(2000);
    logger.info('Bulk API: on masivos page');

    // 3. Process orders SEQUENTIALLY via page.evaluate (browser context)
    // We process one at a time because page.evaluate can only run one at a time.
    // Even so, this is faster than Playwright form-filling (~2s per order vs ~2min).
    const guias: string[] = [];
    const failedRows: number[] = [];
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const items = buildItems(row);
      const result = await processOneOrderInBrowser(page, items, row.orderName);

      if (result.guia) {
        guias.push(result.guia);
      } else {
        failedRows.push(i);
        if (result.error) errors.push(`${row.orderName}: ${result.error}`);
      }

      if ((i + 1) % 5 === 0 || i === rows.length - 1) {
        logger.info({ processed: i + 1, total: rows.length, guias: guias.length, failed: failedRows.length },
          'Bulk API: progress');
      }
    }

    logger.info({ total: rows.length, guias: guias.length, failed: failedRows.length },
      'Bulk API: complete');

    return {
      success: guias.length > 0,
      guias,
      failedRows,
      totalRows: rows.length,
      error: errors.length > 0 ? errors.slice(0, 3).join(' | ') : undefined,
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
