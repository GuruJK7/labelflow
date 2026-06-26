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
