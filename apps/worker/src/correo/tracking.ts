/**
 * Seguimiento de envíos de Correo Uruguayo.
 *
 * Es el endpoint JSON público de la plataforma Ahíva: **no pide credenciales**.
 * Verificado en vivo el 2026-08-28 contra producción.
 *
 *   GET .../servicioConsultaTntIps-ws/seguimientoEnvios/eventosweb?codigoPieza=<código>
 *
 * Capacidad que DAC no da: se puede pollear el estado real de entrega, gratis,
 * y detectar entregado/devuelto sin scrapear nada.
 *
 * Contrato observado (5 sondas con códigos inexistentes, ninguna con datos de
 * terceros):
 *   - Siempre HTTP 200, incluso para un código que no existe.
 *   - El body es un ARRAY con un solo elemento.
 *   - `idNacional` vuelve sólo si el código tiene forma S10 válida; con basura
 *     el campo directamente no aparece.
 *   - Código desconocido → `estado:"NOT_FOUND"`, `codigoEtapaEntrega:"SIN_EVENTOS"`.
 *   - Si se mandan dos `codigoPieza`, se honra el primero y se ignora el resto
 *     → una llamada por código, no hay consulta en lote.
 *
 * ⚠ La forma de `eventos[]` **con datos reales no está verificada**: para verla
 * haría falta un código de un envío existente, y sondear códigos ajenos para
 * conseguir uno sería mirar envíos de terceros. Por eso los eventos se parsean
 * de forma defensiva y se conserva el JSON crudo en `crudo`: nada se pierde
 * aunque la forma real traiga campos que no modelamos.
 */

import axios from 'axios';

export const CORREO_TRACKING_URL =
  'https://ahiva.correo.com.uy/servicioConsultaTntIps-ws/seguimientoEnvios/eventosweb';

/** URL pública para el comprador (la que se le manda por mail). */
export function urlSeguimientoComprador(codigo: string): string {
  return `https://ahiva.correo.com.uy/servicioConsultaTntIps-web/?pieza=${encodeURIComponent(codigo)}`;
}

/**
 * Un evento de la traza. Se deja abierto a propósito: sólo se declaran los
 * campos que se pueden inferir con seguridad, y el resto sobrevive en el
 * índice de firma en vez de perderse.
 */
export interface CorreoEvento {
  [campo: string]: unknown;
}

export interface CorreoSeguimiento {
  codigo: string;
  /** false cuando el servicio contesta NOT_FOUND. */
  encontrado: boolean;
  estado: string;
  codigoEtapaEntrega: string;
  eventos: CorreoEvento[];
  /** El JSON tal cual vino, para no perder nada que no esté modelado. */
  crudo: unknown;
}

/**
 * Valida la forma UPU S10 que usa Correo: dos letras, nueve dígitos y el país.
 * Sirve para no gastar una llamada con un código que evidentemente no es de
 * Correo (una guía DAC, por ejemplo, es numérica y arranca en 88).
 */
export function esCodigoTrazabilidadValido(codigo: string): boolean {
  return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(codigo.trim().toUpperCase());
}

/**
 * Parsea la respuesta. Separado del transporte para poder testear el contrato
 * sin red.
 */
export function parsearSeguimiento(codigo: string, body: unknown): CorreoSeguimiento {
  const primero = Array.isArray(body) ? body[0] : body;
  const obj = (primero ?? {}) as Record<string, unknown>;

  const estado = typeof obj.estado === 'string' ? obj.estado : 'DESCONOCIDO';
  const eventosRaw = obj.eventos;

  return {
    codigo,
    // NOT_FOUND es la única forma documentada de "no existe". Cualquier otro
    // estado se toma como envío real: es preferible reportar un estado que no
    // entendemos que dar por inexistente un envío que sí se despachó.
    encontrado: estado !== 'NOT_FOUND',
    estado,
    codigoEtapaEntrega:
      typeof obj.codigoEtapaEntrega === 'string' ? obj.codigoEtapaEntrega : 'DESCONOCIDO',
    eventos: Array.isArray(eventosRaw) ? (eventosRaw as CorreoEvento[]) : [],
    crudo: body,
  };
}

/** Consulta el estado de UN código. El servicio no acepta lotes. */
export async function consultarSeguimiento(
  codigo: string,
  timeoutMs = 20_000,
): Promise<CorreoSeguimiento> {
  const res = await axios.get(CORREO_TRACKING_URL, {
    params: { codigoPieza: codigo },
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    // El servicio contesta 200 hasta para códigos inexistentes, así que un
    // no-200 es una caída del servicio, no "no encontrado".
    throw new Error(`El seguimiento de Correo respondió HTTP ${res.status}`);
  }

  return parsearSeguimiento(codigo, res.data);
}
