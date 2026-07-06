/**
 * AutoEnvía Dashboard source — reader.
 *
 * Lee los pedidos CONFIRMADOS de la API del dashboard (la "página de Santi") y
 * marca como cargados los que ya se procesaron en DAC. Es el equivalente de
 * shopify/orders.ts pero para esta fuente. NO importa nada de Shopify.
 *
 * Contrato del dashboard (autoenvia-dash):
 *   GET  /api/v1/orders?status=confirmed&limit=N   (Authorization: Bearer <token>)
 *   POST /api/v1/orders/loaded { ids: [...] }       (idempotente; solo confirmed->loaded)
 */
import axios from 'axios';

export interface DashboardOrderAddress {
  full_name: string;
  phone: string;
  department: string;
  address_line: string | null;
  document?: string | null;
  email?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  street?: string | null;
  number?: string | null;
  postal_code?: string | null;
  reference?: string | null;
}

export interface DashboardOrder {
  id: string; // uuid del dashboard
  status: string;
  seller?: { name?: string | null; slug?: string | null } | null;
  buyer_name?: string | null;
  items: Array<{ name: string; qty: number; price: number | null }>;
  address: DashboardOrderAddress | null;
  dac_text?: string | null;
}

const TIMEOUT_MS = 20000;
const trim = (u: string) => u.replace(/\/+$/, '');

/** Trae las órdenes confirmadas (con dirección) listas para cargar en DAC. */
export async function getConfirmedDashboardOrders(
  baseUrl: string,
  token: string,
  limit = 100,
): Promise<DashboardOrder[]> {
  const res = await axios.get(`${trim(baseUrl)}/api/v1/orders`, {
    params: { status: 'confirmed', limit },
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT_MS,
  });
  const orders = (res.data?.orders ?? []) as DashboardOrder[];
  // Solo las que tienen dirección (sin dirección no hay nada para cargar en DAC).
  return orders.filter((o) => o && o.address);
}

/** Marca como cargadas (loaded) las órdenes ya procesadas en DAC. Devuelve cuántas. */
export async function markDashboardOrdersLoaded(
  baseUrl: string,
  token: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const res = await axios.post(
    `${trim(baseUrl)}/api/v1/orders/loaded`,
    { ids },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS },
  );
  return (res.data?.updated as number) ?? 0;
}

/** Registro ENRIQUECIDO de una etiqueta ya generada en DAC. Formato que consume
 *  el receptor `/api/v1/orders/loaded` de AutoEnvía (rama `results`): guarda la
 *  guía + el PDF en el bucket de AutoEnvía para que el cliente imprima desde SU
 *  dashboard. `order_id` = uuid del dashboard. */
export interface DashboardLabelResult {
  order_id: string;
  status: 'labeled';
  tracking?: string | null;
  pdf_base64?: string | null;
  dac_account_used?: string | null;
}

// El body con PDFs en base64 puede ser grande; el receptor corre en Vercel
// (límite de body ~4.5MB). Mandamos en chunks chicos: ~8 PDFs (~70KB c/u en
// base64) ≈ 0.6MB por POST, bien por debajo del límite.
const WRITEBACK_CHUNK = 8;

/**
 * Writeback ENRIQUECIDO: envía guía + PDF (base64) de las órdenes con etiqueta
 * imprimible, en chunks. Idempotente por `order_id` (el receptor upsertea por
 * orden). Incluye también `ids` en cada chunk por compat (un receptor viejo que
 * sólo lea `ids` igual marca cargado). Devuelve cuántas quedaron `labeled`.
 *
 * NO reemplaza a markDashboardOrdersLoaded: sólo se usa para las órdenes con PDF
 * real. Las que no tienen PDF (duplicados, descarga fallida) siguen marcándose
 * por la vía legacy `{ ids }`, preservando el comportamiento actual sin regresión.
 */
export async function pushDashboardLabels(
  baseUrl: string,
  token: string,
  results: DashboardLabelResult[],
): Promise<number> {
  if (!results.length) return 0;
  let labeled = 0;
  for (let i = 0; i < results.length; i += WRITEBACK_CHUNK) {
    const chunk = results.slice(i, i + WRITEBACK_CHUNK);
    const ids = chunk.map((r) => r.order_id);
    const res = await axios.post(
      `${trim(baseUrl)}/api/v1/orders/loaded`,
      { results: chunk, ids },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS },
    );
    labeled += (res.data?.labeled as number) ?? (res.data?.updated as number) ?? 0;
  }
  return labeled;
}
