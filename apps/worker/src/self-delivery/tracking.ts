import { createHash } from 'node:crypto';

/**
 * Codigo de seguimiento propio de LabelFlow, para los envios que no pasan por DAC.
 *
 * Vive en la misma columna que la guia de DAC (Label.dacGuia, que es @unique),
 * asi que tiene que cumplir dos cosas:
 *
 *  1. NO COLISIONAR con una guia de DAC. Las de DAC son numericas ("2355997");
 *     el prefijo "LF-" garantiza que nunca se pisan, y ademas deja ver de un
 *     vistazo en el dashboard cual envio fue por DAC y cual por reparto propio.
 *
 *  2. SER ESTABLE PARA EL MISMO PEDIDO. El job reintenta pedidos fallidos en
 *     cada tick del cron. Si el codigo fuera aleatorio, un reintento chocaria
 *     contra la restriccion @unique con un codigo nuevo, o peor: dejaria dos
 *     etiquetas distintas circulando para el mismo paquete. Derivarlo por hash
 *     de (tenant, pedido) lo hace idempotente — reintentar da el MISMO codigo.
 *
 * Alfabeto: Crockford base32 sin I, L, O ni U. Sin los caracteres que se
 * confunden a mano o al leer una etiqueta impresa mal (I/1, O/0), y sin la U
 * para que no salgan palabras desafortunadas por azar.
 */
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 simbolos

export const TRACKING_PREFIJO = 'LF-';

/** Largo de la parte aleatoria. 8 simbolos de 32 = 32^8 ≈ 1,1 billones. */
const LARGO = 8;

/**
 * Devuelve el codigo de seguimiento para un pedido. Determinista: la misma
 * entrada da siempre la misma salida.
 */
export function codigoSeguimiento(tenantId: string, shopifyOrderId: string): string {
  const h = createHash('sha256').update(`${tenantId}:${shopifyOrderId}`).digest();
  let out = '';
  for (let i = 0; i < LARGO; i++) out += ALFABETO[h[i] % 32];
  return `${TRACKING_PREFIJO}${out}`;
}

/** true si el codigo lo emitio LabelFlow (y no DAC). */
export const esCodigoPropio = (guia: string | null | undefined): boolean =>
  typeof guia === 'string' && guia.startsWith(TRACKING_PREFIJO);
