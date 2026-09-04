/**
 * CONTRAREEMBOLSO de Correo Uruguayo (mercadería a cobrar en destino).
 *
 * QUÉ ES. En el portal AhíVA es el paso 3 ("Registro de piezas"), la pregunta
 * "¿Contiene mercadería a cobrar en destino?". Cuando se responde Sí, aparecen
 * "Servicio de contrarrembolso pagado por", "Referencia / Remito / No Factura",
 * "Moneda" y "Valor total". En el WebService eso NO es un campo suelto: es una
 * ESTRUCTURA distinta. El paquete deja de ir en `paquetesSimples` y pasa a vivir
 * dentro de `contraReembolsos[].paquetes`, con el monto y la referencia al lado.
 *
 * Regla textual del contrato, ya anotada en types.ts:141-144:
 *   «`paquetesSimples` son SÓLO los paquetes SIN mercadería a cobrar. Los que sí
 *    llevan cobro van dentro de `contraReembolsos[].paquetes`. No se duplican.»
 *
 * Duplicar el paquete en las dos listas es el error caro de este apartado: el
 * envío saldría con dos piezas facturadas y una sola caja real.
 *
 * ⚠️ POR QUÉ ESTE ARCHIVO NO IMPORTA `dac/contrarreembolso.ts`. La lógica es
 * gemela (`planDeCod`), pero los límites NO son los mismos: DAC usa un tope de
 * cordura propio de $500.000 y Correo tiene un tope REAL de $30.000 publicado en
 * su tarifario. Importar el de DAC ataría el carrier nuevo a la carpeta
 * intocable y —peor— le prestaría un tope que no es el suyo. Es la misma
 * duplicación deliberada que ya documenta `apps/web/lib/contrarreembolso.ts`.
 *
 * Puro: sin red, sin DB, sin Playwright.
 */

import type { ResponsablePago } from './types';

/**
 * Tope de mercadería que Correo acepta cobrar en destino.
 *
 * 🔴 DATO VOLÁTIL. Sale del tarifario oficial de Ahíva (`correo.com.uy/tarifas-ahiva`,
 * `Tarifas_Ahiva.pdf`), vigencia declarada 01/11/2025, verificado el 2026-08-27:
 * «Contra reembolso: máximo $30.000 de mercadería». No está declarado en el WSDL
 * —ahí `monto` es un `xs:double` libre—, así que si Correo lo mueve, el schema no
 * lo va a avisar: lo avisa un rechazo en runtime. Re-verificar contra el PDF antes
 * de subirlo.
 */
export const CORREO_COD_MONTO_MAX = 30_000;

/**
 * Costo del servicio de contrareembolso, del mismo tarifario y con la misma
 * volatilidad: $111 fijos + 1% del valor de la mercadería. Se usa SÓLO para
 * estimar antes de despachar. La cifra que vale es la que devuelve AHIVA en
 * `costos.detalle.costoContrareembolso_*`, nunca ésta.
 */
export const CORREO_COD_CARGO_FIJO = 111;
export const CORREO_COD_CARGO_PORCENTUAL = 0.01;

/** Lo que hay que resolver para poder armar el `dataContraReembolso`. */
export interface EntradaCod {
  /** Monto de la mercadería a cobrar, en pesos. null/undefined = NO es contrareembolso. */
  codAmount?: number | null;
  /**
   * Nº de factura / remito / referencia de control del remitente. En el portal es
   * el campo "Referencia / Remito / No Factura" y es obligatorio.
   */
  nroReferencia?: string | null;
  /** Quién paga el COSTO del servicio de contrareembolso. */
  pagaServicioCod?: ResponsablePago;
}

export type PlanCod =
  | { esCod: false }
  | { esCod: false; motivo: string }
  | {
      esCod: true;
      monto: number;
      nroreferencia: string;
      responsableServContraReembolso: ResponsablePago;
    };

/**
 * Decide si un pedido es contrareembolso y con qué valores exactos.
 *
 * La asimetría de los casos dudosos es deliberada y es la misma que eligió el
 * apartado de DAC: ante null / 0 / negativo / NaN se devuelve `esCod:false` SIN
 * motivo — no es un error, es un envío normal que no lleva cobro. En cambio un
 * monto que existe pero NO se puede despachar (fuera de tope, sin referencia)
 * devuelve `esCod:false` CON motivo, para que el pre-vuelo lo mande a revisión
 * en vez de despacharlo en silencio como si no tuviera cobro.
 *
 * Esa distinción es el corazón del archivo: "no es contrareembolso" y "es
 * contrareembolso y está mal cargado" tienen que terminar en lugares distintos.
 * Colapsarlos significaría entregar la mercadería sin cobrarla.
 *
 * @param referenciaPedido referencia del pedido, usada como `nroreferencia` si
 *   no vino una propia. Correo la exige y la imprime en el remito.
 */
export function planDeCodCorreo(e: EntradaCod, referenciaPedido?: string | null): PlanCod {
  const m = e.codAmount;

  // --- casos que simplemente NO son contrareembolso (sin motivo) -------------
  if (m === null || m === undefined) return { esCod: false };
  if (typeof m !== 'number' || !Number.isFinite(m)) return { esCod: false };

  // AHIVA toma `monto` como xs:double, pero el portal sólo permite enteros y los
  // costos vuelven redondeados. Se redondea acá para que lo que se manda sea
  // exactamente lo que se guardó y lo que se le va a cobrar al destinatario.
  const monto = Math.round(m);
  if (monto <= 0) return { esCod: false };

  // --- casos que SÍ son contrareembolso pero no se pueden despachar ---------
  if (monto > CORREO_COD_MONTO_MAX) {
    return {
      esCod: false,
      motivo:
        `Contrareembolso de $${monto}: Correo Uruguayo no cobra en destino más de ` +
        `$${CORREO_COD_MONTO_MAX} de mercadería (tarifario vigente 01/11/2025). ` +
        'Este envío no puede salir como contrareembolso.',
    };
  }

  const nroreferencia = (e.nroReferencia ?? '').trim() || (referenciaPedido ?? '').trim();
  if (!nroreferencia) {
    return {
      esCod: false,
      motivo:
        'Contrareembolso sin nº de referencia/remito/factura: Correo lo exige para ' +
        'poder liquidarle la plata al remitente.',
    };
  }

  return {
    esCod: true,
    monto,
    nroreferencia,
    // El default replica lo que muestra el portal en el caso típico de
    // e-commerce: el destinatario paga tanto el flete como el servicio de cobro.
    responsableServContraReembolso: e.pagaServicioCod ?? 'DESTINATARIO',
  };
}

/** Para la UI y los filtros: ¿este pedido sale con cobro en destino? */
export function esContrareembolso(e: EntradaCod, referenciaPedido?: string | null): boolean {
  return planDeCodCorreo(e, referenciaPedido).esCod;
}

/**
 * Estimación del cargo por el servicio de contrareembolso, en pesos.
 * Redondeado a entero. `null` si el monto no es un contrareembolso válido.
 *
 * DATO VOLÁTIL — ver el comentario de las constantes. Sirve para mostrarle al
 * comerciante un orden de magnitud antes de despachar, no para facturar.
 */
export function estimarCargoCodUYU(monto: number): number | null {
  if (!Number.isFinite(monto) || monto <= 0 || monto > CORREO_COD_MONTO_MAX) return null;
  return Math.round(CORREO_COD_CARGO_FIJO + monto * CORREO_COD_CARGO_PORCENTUAL);
}
