/**
 * Quién despachó cada envío, y adónde manda al comprador a rastrearlo.
 *
 * Hasta hoy la respuesta estaba escrita a mano en seis lugares distintos, todos
 * diciendo "DAC". Eso ya está roto en producción para el reparto propio: el mail
 * de fulfillment le llega al comprador con un link a `dac.com.uy/rastrear?guia=LF-…`
 * y una guía que DAC no conoce. Con Correo Uruguayo el mismo defecto se
 * multiplica, así que la respuesta pasa a vivir en una sola función.
 *
 * ⚠️ COPIA DELIBERADA de `apps/worker/src/transportista.ts`. Mismo motivo que
 * `lib/contrarreembolso.ts` y que `DEPARTAMENTOS_REPARTO_PROPIO`: apps/web y
 * apps/worker se compilan y empaquetan por separado (el Dockerfile del worker no
 * incluye packages/), así que un import cruzado typechequea y explota al
 * resolver módulos en runtime. 🔴 SI TOCÁS UNO, TOCÁ EL OTRO.
 */

export type Transportista = 'DAC' | 'CORREO' | 'PROPIO';

/**
 * Código de trazabilidad de Correo: formato UPU S10 — dos letras, nueve dígitos
 * y el país. Ej: "PC021042235UY". No colisiona con las guías de DAC, que son
 * numéricas, ni con las de reparto propio, que empiezan con "LF-".
 */
const S10 = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

/**
 * Resuelve el transportista de una etiqueta.
 *
 * `carrier` es la fuente de verdad. La inferencia por el formato de la guía es
 * el fallback para las ~11.600 filas históricas, que tienen `carrier` en NULL
 * porque no se backfillearon a propósito (agregar la columna no reescribió la
 * tabla). Para esas, NULL significa DAC.
 */
export function transportistaDe(
  carrier: string | null | undefined,
  guia: string | null | undefined,
): Transportista {
  if (carrier === 'CORREO' || carrier === 'PROPIO' || carrier === 'DAC') return carrier;
  const g = (guia ?? '').trim().toUpperCase();
  if (g.startsWith('LF-')) return 'PROPIO';
  if (S10.test(g)) return 'CORREO';
  return 'DAC';
}

/** Nombre para mostrarle al comerciante y al comprador. */
export function nombreTransportista(t: Transportista): string {
  switch (t) {
    case 'CORREO':
      return 'Correo Uruguayo';
    case 'PROPIO':
      return 'Reparto propio';
    default:
      return 'DAC';
  }
}

/**
 * URL pública de rastreo, o `null` si ese transportista no tiene una.
 *
 * Devolver null es importante: un envío de reparto propio no se rastrea en
 * ningún lado, y mandarle al comprador un link roto es peor que no mandarle
 * ninguno. Los llamadores tienen que tratar el null como "no mostrar el botón".
 */
export function urlRastreo(t: Transportista, guia: string | null | undefined): string | null {
  const g = (guia ?? '').trim();
  if (!g) return null;
  switch (t) {
    case 'CORREO':
      return `https://ahiva.correo.com.uy/servicioConsultaTntIps-web/?pieza=${encodeURIComponent(g)}`;
    case 'PROPIO':
      return null;
    default:
      return `https://www.dac.com.uy/envios/rastrear?guia=${encodeURIComponent(g)}`;
  }
}

/** Atajo: transportista + nombre + link, a partir de lo que guarda Label. */
export function rastreoDeLabel(
  carrier: string | null | undefined,
  guia: string | null | undefined,
): { transportista: Transportista; nombre: string; url: string | null } {
  const transportista = transportistaDe(carrier, guia);
  return {
    transportista,
    nombre: nombreTransportista(transportista),
    url: urlRastreo(transportista, guia),
  };
}
