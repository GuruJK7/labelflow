/**
 * Generates a .xlsx file for DAC's bulk upload (masivos) endpoint.
 *
 * Format: 10 columns, NO headers, positional mapping:
 *   A: Nombre destinatario (text)
 *   B: Telefono (text)
 *   C: Direccion (text)
 *   D: K_Estado — department ID (numeric)
 *   E: K_Ciudad — city ID (numeric)
 *   F: Oficina_destino — office ID (numeric)
 *   G: Observaciones (text)
 *   H: Email (text)
 *   I: K_Tipo_Empaque — package type ID (numeric, default 1 = Hasta 2Kg)
 *   J: Cantidad (numeric, default 1)
 *
 * Discovered by reverse-engineering dac.com.uy/envios/masivos on 2026-04-14.
 * See the session notes for the full investigation trail.
 */

import * as XLSX from 'xlsx';
import fs from 'fs';
import { ShopifyOrder } from '../shopify/types';
import { mergeAddress } from './shipment';
import { resolveShopifyAddressToDacIds } from './dac-geo-resolver';
import { getDepartmentForCity } from './uruguay-geo';
import { determinePaymentType } from '../rules/payment';
import logger from '../logger';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface BulkXlsxRow {
  orderName: string;
  orderId: number;
  nombre: string;
  telefono: string;
  direccion: string;
  kEstado: number;
  kCiudad: number;
  oficina: number;
  observaciones: string;
  email: string;
  empaque: number;
  cantidad: number;
  paymentType: 'REMITENTE' | 'DESTINATARIO';
  /** Set to true if this order couldn't be mapped to DAC IDs and needs Playwright fallback */
  needsFallback: boolean;
  fallbackReason?: string;
}

export interface BulkXlsxResult {
  /** The xlsx buffer ready to upload to DAC */
  xlsxBuffer: Buffer;
  /** Rows included in the xlsx (successfully mapped) */
  includedRows: BulkXlsxRow[];
  /** Rows that need Playwright fallback (unmapped) */
  fallbackRows: BulkXlsxRow[];
  /** Total orders processed */
  totalOrders: number;
}

// ─────────────────────────────────────────────────────────────────────
// Main generator
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert an array of Shopify orders into a DAC bulk-upload xlsx buffer.
 *
 * Orders that can't be mapped to DAC IDs (missing department, unknown city,
 * no office) are separated into `fallbackRows` for Playwright processing.
 */
export function generateBulkXlsx(
  orders: ShopifyOrder[],
  paymentThreshold: number,
  paymentRuleEnabled: boolean,
): BulkXlsxResult {
  const includedRows: BulkXlsxRow[] = [];
  const fallbackRows: BulkXlsxRow[] = [];

  for (const order of orders) {
    const addr = order.shipping_address;
    if (!addr || !addr.address1) {
      fallbackRows.push({
        orderName: order.name,
        orderId: order.id,
        nombre: '',
        telefono: '',
        direccion: '',
        kEstado: 0,
        kCiudad: 0,
        oficina: 0,
        observaciones: '',
        email: '',
        empaque: 1,
        cantidad: 1,
        paymentType: 'DESTINATARIO',
        needsFallback: true,
        fallbackReason: 'No shipping address',
      });
      continue;
    }

    // Merge address (same logic as Playwright flow)
    const { fullAddress, extraObs } = mergeAddress(addr.address1, addr.address2);

    // Resolve department
    const shopifyDept = getDepartmentForCity(addr.city) ?? addr.province ?? '';
    const resolvedCity = addr.city ?? '';

    // Map to DAC IDs
    const dacIds = resolveShopifyAddressToDacIds(shopifyDept, resolvedCity);

    // Customer info
    const customerName = `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente';
    const phone = addr.phone ?? '';
    const email = order.email ?? '';

    // Payment type
    const paymentType = determinePaymentType(order, paymentThreshold, paymentRuleEnabled);

    // Build the row
    const row: BulkXlsxRow = {
      orderName: order.name,
      orderId: order.id,
      nombre: customerName,
      telefono: phone,
      direccion: fullAddress,
      kEstado: dacIds?.kEstado ?? 0,
      kCiudad: dacIds?.kCiudad ?? 0,
      oficina: dacIds?.oficinaDestino ?? 0,
      observaciones: extraObs,
      email,
      empaque: 1, // Default: Hasta 2Kg 20x20x20
      cantidad: 1,
      paymentType,
      needsFallback: !dacIds,
      fallbackReason: dacIds ? undefined : `Could not map dept="${shopifyDept}" city="${resolvedCity}" to DAC IDs`,
    };

    if (row.needsFallback) {
      fallbackRows.push(row);
    } else {
      includedRows.push(row);
    }
  }

  // Generate xlsx from included rows only
  //
  // Column layout discovered by trial and error against DAC's /envios/masivos:
  // DAC expects ALL form fields as columns, including the shipment type selects
  // and the origin office. The column order matches the form field order.
  //
  // Discovery timeline:
  //   v1 (10 cols, no TipoGuia): error "Oficina_destino not numeric"
  //   v2 (11 cols, +TipoGuia at A): error "Oficina_Origen not numeric"
  //   v3 (15 cols, ALL form fields): includes TipoServicio, TipoGuia, TipoEnvio,
  //       TipoEntrega, Oficina_Origen before the recipient data
  const xlsxData = includedRows.map(row => [
    1,                  // A: TipoServicio (1=Levante, always 1)
    row.paymentType === 'REMITENTE' ? 1 : 4, // B: TipoGuia (1=paga remitente, 4=paga destinatario)
    1,                  // C: TipoEnvio (1=Paquete)
    2,                  // D: TipoEntrega (2=A Domicilio)
    1,                  // E: Oficina_Origen (1=default origin, auto-assigned by DAC)
    row.nombre,         // F: Nombre destinatario
    row.telefono,       // G: Telefono
    row.direccion,      // H: Direccion
    row.kEstado,        // I: K_Estado (dept ID)
    row.kCiudad,        // J: K_Ciudad (city ID)
    row.oficina,        // K: Oficina_destino (office ID)
    row.observaciones,  // L: Observaciones
    row.email,          // M: Email
    row.empaque,        // N: K_Tipo_Empaque
    row.cantidad,       // O: Cantidad
  ]);

  const ws = XLSX.utils.aoa_to_sheet(xlsxData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Envios');

  // Write to a temp file first (XLSX.writeFile is more reliable than
  // XLSX.write + manual buffer handling across Node environments), then
  // read back as Buffer. This matches the approach that worked in manual tests.
  const tmpXlsxPath = `/tmp/bulk_gen_${Date.now()}.xlsx`;
  XLSX.writeFile(wb, tmpXlsxPath);
  const xlsxBuffer = fs.readFileSync(tmpXlsxPath);
  fs.unlinkSync(tmpXlsxPath);

  // DEBUG: verify cell types from the worksheet before writing
  const debugCells: Record<string, unknown> = {};
  for (const key of ['A1','B1','C1','D1','E1','F1','G1','H1','I1','J1']) {
    const cell = ws[key];
    debugCells[key] = cell ? { v: cell.v, t: cell.t } : 'missing';
  }
  // Also log the first row raw data
  const firstRow = xlsxData[0];

  logger.info({
    totalOrders: orders.length,
    included: includedRows.length,
    fallback: fallbackRows.length,
    xlsxSize: xlsxBuffer.length,
    cells: debugCells,
    firstRowTypes: firstRow?.map((v: unknown, i: number) => `${i}:${typeof v}`),
    firstRowValues: firstRow?.map((v: unknown, i: number) => `${i}:${String(v).slice(0,20)}`),
  }, 'Bulk xlsx generated');

  return {
    xlsxBuffer,
    includedRows,
    fallbackRows,
    totalOrders: orders.length,
  };
}
