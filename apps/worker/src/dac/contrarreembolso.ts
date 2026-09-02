/**
 * CONTRAREEMBOLSO (COD) — apartado nuevo, aislado a propósito.  [01-sep-2026]
 *
 * QUÉ ES. DAC agregó una tercera opción en el select "Tipo de Guía" del formulario
 * de alta de envíos: además de "Paga remitente" y "Paga destinatario", ahora existe
 * "Contrareembolso", donde DAC le COBRA LA MERCADERÍA al destinatario y le gira la
 * plata al remitente. Es distinto de "Paga destinatario", que sólo dice quién paga
 * el FLETE. El repo tenía las dos primeras y no la tercera.
 *
 * VALORES REALES, leídos del DOM en vivo de dac.com.uy/envios/nuevo el 01/09/2026:
 *
 *   select[name="TipoGuia"]   1 → "Paga remitente"
 *                             4 → "Paga destinatario"
 *                             6 → "Contrareembolso"      ← el nuevo
 *
 *   input[name="CostoMercaderia"]  "Costo de la mercadería ($)", pattern="[0-9]*",
 *                                  default "0", vive en el paso 4 del wizard.
 *
 * ⚠️ OJO CON LA ORTOGRAFÍA: DAC lo escribe "Contrareembolso", con UNA sola R.
 *
 * POR QUÉ ESTE ARCHIVO EXISTE EN VEZ DE TOCAR shipment.ts. La automatización
 * Playwright de DAC es intocable por regla del dueño del proyecto, y con razón:
 * son ~3.800 líneas sin un solo test sobre el llenado de TipoGuia, y un value mal
 * puesto emite guías reales mal facturadas en la cuenta del cliente. Toda la lógica
 * de decisión vive acá, es PURA (sin Playwright, sin red, sin DB) y está cubierta
 * por tests. El día que se integre, shipment.ts necesita UNA línea.
 *
 * POR QUÉ NO SE TOCÓ EL enum PaymentType. Hay tres lugares que hacen
 * `paymentType === 'REMITENTE' ? a : b` y tratan cualquier otro valor como
 * DESTINATARIO — uno de ellos (apps/web/lib/stuck-labels.ts:73) NO es cosmético,
 * decide cómo se reconcilia un envío trabado. Un tercer valor en el enum los
 * rompería en silencio. El contrareembolso se modela aparte, con `Label.codAmount`
 * nullable: si es null, el sistema se comporta EXACTAMENTE como antes.
 */

/** Value del select TipoGuia para contrareembolso. Verificado en el DOM, 01/09/2026. */
export const DAC_TIPO_GUIA_CONTRAREEMBOLSO = '6';

/** Selector del campo donde va el monto a cobrar (paso 4 del wizard). */
export const DAC_COSTO_MERCADERIA_SELECTOR = 'input[name="CostoMercaderia"]';

/** Texto exacto de la opción en DAC — una sola R, así lo escriben ellos. */
export const DAC_TIPO_GUIA_LABEL = 'Contrareembolso';

/** Tope de cordura. Un COD por encima de esto casi seguro es un error de carga
 *  (centavos tomados como pesos, o el total de un lote en vez de un pedido). */
export const COD_MONTO_MAX = 500_000;

export interface EntradaCod {
  /** Monto a cobrar en pesos. null/undefined = NO es contrareembolso. */
  codAmount?: number | null;
}

export type PlanCod =
  | { esCod: false }
  | { esCod: true; tipoGuia: string; costoMercaderia: string; monto: number };

/**
 * Convierte el monto guardado en lo que hay que escribir en el formulario de DAC.
 *
 * Devuelve `{ esCod: false }` en todo caso dudoso — null, 0, negativo, decimal
 * imposible, NaN o fuera del tope. La asimetría es deliberada: no emitir un COD
 * cuando correspondía es una molestia; emitirlo con el monto equivocado es plata
 * mal cobrada a un cliente final y una guía que hay que anular a mano.
 */
export function planDeCod(e: EntradaCod): PlanCod {
  const m = e.codAmount;
  if (m === null || m === undefined) return { esCod: false };
  if (typeof m !== 'number' || !Number.isFinite(m)) return { esCod: false };
  const entero = Math.round(m);
  if (entero <= 0) return { esCod: false };
  if (entero > COD_MONTO_MAX) return { esCod: false };
  return {
    esCod: true,
    tipoGuia: DAC_TIPO_GUIA_CONTRAREEMBOLSO,
    // pattern="[0-9]*": sólo dígitos. Sin separador de miles, sin decimales, sin $.
    costoMercaderia: String(entero),
    monto: entero,
  };
}

/** Para la UI y los filtros: ¿esta guía es contrareembolso? */
export function esContrareembolso(e: EntradaCod): boolean {
  return planDeCod(e).esCod;
}

/**
 * Etiqueta para mostrar. Reemplaza al ternario binario que trataba cualquier
 * cosa que no fuera REMITENTE como "Destinatario".
 */
export function etiquetaDePago(paymentType: string | null | undefined, e: EntradaCod): string {
  if (esContrareembolso(e)) return 'Contrareembolso';
  return paymentType === 'REMITENTE' ? 'Remitente' : 'Destinatario';
}
