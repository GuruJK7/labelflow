/**
 * De dónde salen los pedidos que se despachan.
 *
 * `process-dashboard-orders.job.ts` hace todo lo difícil —lock de DAC, gate de
 * créditos, guarda de storage, filtro anti-duplicados, reconcile de huérfanas,
 * createShipment, upsert de Label, PDF, ledger, checkpoint por orden, y la rama
 * entera de Correo Uruguayo— y casi nada de eso depende del ORIGEN de los
 * pedidos. Lo único que cambia entre una fuente y otra son cuatro cosas:
 * si está configurada, cómo se traen, cómo se marcan cargadas y (opcional) cómo
 * se le devuelve la etiqueta al origen.
 *
 * Este puerto aísla esas cuatro. Todo lo demás del job se ejecuta igual para
 * todas, que es justamente el objetivo: una fuente nueva no puede divergir en
 * cobro, dedup ni manejo de errores porque no tiene dónde hacerlo.
 *
 * 🔑 Las fuentes hablan `DashboardOrder`, no un shape propio. No es por pereza:
 * el adaptador (`dashboard/adapter.ts`) y su `stableNumericId` son los que fijan
 * la identidad del pedido de cara al dedup de DAC, y esa identidad tiene que ser
 * una sola para todo el sistema. Una fuente que inventara su propio shape se
 * llevaría puesto ese contrato.
 */
import type { DashboardOrder, TraidaDashboard, DashboardLabelResult } from '../dashboard/orders';

/** Para qué tenant y con qué credenciales corre esta fuente. */
export interface TenantDeFuente {
  id: string;
  dashboardUrl: string | null;
  dashboardToken: string | null;
  dashboardSourceEnabled: boolean;
  internalSourceEnabled: boolean;
}

export type Configuracion<Ctx> =
  | { ok: true; ctx: Ctx }
  /** Motivo legible; va tal cual a `Job.errorMessage`, así que lo lee un humano. */
  | { ok: false; motivo: string };

export interface FuenteDePedidos<Ctx = unknown> {
  /** Para los logs y los mensajes de error. */
  readonly nombre: string;

  /**
   * ¿Esta tienda tiene la fuente lista? Devuelve el contexto (URLs, tokens ya
   * descifrados, el id del tenant…) que después reciben los otros métodos, para
   * que el job no tenga que saber qué necesita cada fuente.
   */
  configurar(tenant: TenantDeFuente): Configuracion<Ctx>;

  /** Los pedidos listos para despachar, más lo que se perdió por el camino. */
  traer(ctx: Ctx, limit: number): Promise<TraidaDashboard>;

  /**
   * Marcar como despachados los `ids` (el `DashboardOrder.id` de cada uno) para
   * que no vuelvan en el próximo ciclo. Devuelve cuántos se actualizaron.
   *
   * Es best-effort por contrato: si falla, el backstop es `assertNoPriorSubmit`
   * dentro de `createShipment`, que bloquea un segundo envío del mismo pedido.
   */
  marcarCargadas(ctx: Ctx, ids: string[]): Promise<number>;

  /**
   * Devolverle al origen la guía y el PDF. Sólo lo necesita una fuente REMOTA,
   * donde el cliente imprime del otro lado. La fuente interna no lo implementa:
   * el PDF ya quedó en Supabase y en `Label.pdfPath`, que es de donde lo lee la
   * web — mandárselo a sí misma en base64 no tendría sentido.
   */
  publicarEtiquetas?(ctx: Ctx, resultados: DashboardLabelResult[]): Promise<number>;
}

export type { DashboardOrder, TraidaDashboard, DashboardLabelResult };
