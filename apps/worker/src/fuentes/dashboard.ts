/**
 * Fuente REMOTA: el dashboard externo (DEPO, VentaFlow, el panel de Santi).
 *
 * Es el comportamiento que este job tuvo siempre, movido detrás del puerto sin
 * cambiarle una coma: mismas llamadas, mismos parámetros, mismo orden. Si algo
 * acá se comporta distinto que antes, es un bug.
 */
import { decryptIfPresent } from '../encryption';
import {
  traerConfirmadasDelDashboard,
  markDashboardOrdersLoaded,
  pushDashboardLabels,
} from '../dashboard/orders';
import type { FuenteDePedidos, TenantDeFuente, Configuracion, DashboardLabelResult } from './tipos';

export interface CtxDashboard {
  url: string;
  token: string;
}

export const fuenteDashboard: FuenteDePedidos<CtxDashboard> = {
  nombre: 'dashboard',

  configurar(tenant: TenantDeFuente): Configuracion<CtxDashboard> {
    const url = tenant.dashboardUrl;
    const token = decryptIfPresent(tenant.dashboardToken);
    if (!tenant.dashboardSourceEnabled || !url || !token) {
      return { ok: false, motivo: 'Missing dashboard config' };
    }
    return { ok: true, ctx: { url, token } };
  },

  traer(ctx, limit) {
    return traerConfirmadasDelDashboard(ctx.url, ctx.token, limit);
  },

  marcarCargadas(ctx, ids) {
    return markDashboardOrdersLoaded(ctx.url, ctx.token, ids);
  },

  publicarEtiquetas(ctx, resultados: DashboardLabelResult[]) {
    return pushDashboardLabels(ctx.url, ctx.token, resultados);
  },
};
