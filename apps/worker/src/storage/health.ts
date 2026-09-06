import { createClient } from '@supabase/supabase-js';
import { getConfig } from '../config';
import logger from '../logger';

/**
 * ¿El storage acepta escrituras AHORA?  [06-09-2026]
 *
 * 🔴 EL INCIDENTE QUE ESTO EVITA. Supabase restringió el proyecto por cuota de
 * egress y devolvió 402 a toda subida:
 *
 *   "Service for this project is restricted due to the following violations:
 *    exceed_egress_quota. The project owner must upgrade their plan or remove
 *    spend caps to restore service."
 *
 * El orden del despacho era: emitir la guía en DAC → bajar el PDF → subirlo. Con
 * el storage caído, los dos primeros pasos igual salían bien, así que el sistema
 * emitió **120 guías reales y facturadas por DAC en poco más de un día**, todas
 * sin etiqueta imprimible. El job hacía lo correcto con lo que sabía —las dejaba
 * NEEDS_REVIEW y no cobraba el crédito— pero el daño ya estaba hecho: una guía
 * de DAC no se "deshace", hay que anularla a mano.
 *
 * La regla que faltaba es simple: **no emitas una guía que no vas a poder
 * entregar.** Esta comprobación va ANTES de abrir DAC, no después.
 *
 * Cuesta una subida de 5 bytes que se borra enseguida. Comparado con abrir un
 * navegador, loguearse a DAC y emitir 20 envíos, es gratis.
 *
 * Fail-closed: cualquier error —incluido no tener Supabase configurado— cuenta
 * como "no escribible". Un run que no arranca es un problema; 20 guías que no se
 * pueden imprimir es un problema mucho peor.
 */
export interface EstadoStorage {
  escribible: boolean;
  /** Vacío cuando `escribible`. Es el mensaje textual del proveedor. */
  error: string;
}

export async function verificarStorage(): Promise<EstadoStorage> {
  const config = getConfig();
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    return { escribible: false, error: 'Supabase no está configurado (falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY)' };
  }

  try {
    const sb = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    // Nombre fijo por proceso + timestamp: no deja basura acumulada aunque el
    // borrado falle, y `upsert` evita chocar con una corrida simultánea.
    const ruta = `_healthcheck/${Date.now()}-${process.pid}.txt`;
    const { error } = await sb.storage
      .from(config.SUPABASE_STORAGE_BUCKET)
      .upload(ruta, Buffer.from('ping\n'), { contentType: 'text/plain', upsert: true });

    if (error) {
      logger.error({ error: error.message }, '[storage] La comprobación de escritura falló');
      return { escribible: false, error: error.message };
    }

    // El borrado es best-effort: si falla, el archivo pesa 5 bytes.
    await sb.storage.from(config.SUPABASE_STORAGE_BUCKET).remove([ruta]).catch(() => {});
    return { escribible: true, error: '' };
  } catch (err) {
    const error = (err as Error).message;
    logger.error({ error }, '[storage] La comprobación de escritura tiró una excepción');
    return { escribible: false, error };
  }
}

/** El mensaje que ve el comerciante cuando una corrida se aborta por esto. */
export function motivoStorageCaido(error: string): string {
  return (
    'No se procesó ningún pedido: el almacenamiento de etiquetas no está disponible, ' +
    'así que una guía emitida ahora no se podría imprimir. No se emitió ninguna guía ' +
    `y no se descontó ningún envío. Detalle del proveedor: ${error}`
  );
}
