/**
 * Retención de DATOS PERSONALES en las etiquetas.
 *
 * 🔴 POR QUÉ EXISTE. La política de privacidad, cláusula 6, promete: «Los datos
 * personales se conservarán por un período máximo de 24 meses […] Transcurrido
 * dicho plazo, los datos serán eliminados de forma automática y definitiva».
 * Hasta el 2026-09-03 eso NO PASABA. El único job de retención que había
 * (`pdf-retention.job.ts`) borra los PDF a los 15 días para acotar el costo de
 * almacenamiento y dice explícitamente que lo hace «WITHOUT touching the Label
 * rows» — y esas filas guardan `customerName`, `customerEmail`,
 * `customerPhone` y `deliveryAddress`. O sea: un documento legal, bajo Ley
 * 18.331, prometía un borrado que ningún código ejecutaba.
 *
 * ANONIMIZA, NO BORRA LA FILA, y no es un atajo: la MISMA cláusula 6 dice que
 * «los registros de etiquetas y envíos se conservarán por el período legalmente
 * requerido para fines de facturación y auditoría (5 años…)». Las dos cosas
 * conviven de una sola forma: se van los datos que identifican a una persona y
 * queda el registro contable. Por eso `city` y `department` SOBREVIVEN — son
 * agregados geográficos, no identifican a nadie— y también la guía, los montos
 * y las fechas.
 *
 * IDEMPOTENTE. Una fila anonimizada deja de matchear el filtro (`customerName`
 * pasa a `ANONIMIZADO`), así que el lote siguiente no la vuelve a tomar y el
 * bucle termina solo. Correrlo dos veces no cambia nada.
 *
 * NO TOCA NADA RECIENTE. El corte es a 24 meses; el caso de uso del producto
 * (imprimir la etiqueta del día, reclamar un envío) vive en días, no en años.
 */
import { db } from '../db';
import logger from '../logger';

/** Marca visible en la fila anonimizada. No es un dato personal ni un nombre real. */
export const ANONIMIZADO = 'ANONIMIZADO';

/**
 * Meses que se conservan los datos personales. Tiene que coincidir con lo que
 * dice la política de privacidad: si alguien cambia uno, cambia el otro.
 */
export const PII_RETENTION_MONTHS = (() => {
  const n = Number(process.env.PII_RETENTION_MONTHS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24;
})();

const INTERVALO_MS = 24 * 60 * 60 * 1000; // una vez por día
const LOTE = 500;
const MAX_LOTES = 40; // tope por corrida: el resto queda para la del día siguiente

/** El instante a partir del cual una etiqueta ya cumplió su plazo. */
export function cutoffFor(now: Date, months = PII_RETENTION_MONTHS): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d;
}

/**
 * Los campos que se van y con qué se reemplazan.
 *
 * `customerEmail` y `customerPhone` van a `null` (son opcionales en el schema);
 * `customerName` y `deliveryAddress` son NOT NULL, así que llevan la marca.
 */
export const CAMPOS_ANONIMIZADOS = {
  customerName: ANONIMIZADO,
  customerEmail: null,
  customerPhone: null,
  deliveryAddress: ANONIMIZADO,
} as const;

export interface ResultadoRetencion {
  anonimizadas: number;
  lotes: number;
  truncado: boolean;
}

export async function runPiiRetention(now = new Date()): Promise<ResultadoRetencion> {
  const cutoff = cutoffFor(now);
  let anonimizadas = 0;
  let lotes = 0;

  while (lotes < MAX_LOTES) {
    const filas = await db.label.findMany({
      where: { createdAt: { lt: cutoff }, customerName: { not: ANONIMIZADO } },
      select: { id: true },
      take: LOTE,
    });
    if (filas.length === 0) break;

    await db.label.updateMany({
      where: { id: { in: filas.map((f) => f.id) } },
      data: CAMPOS_ANONIMIZADOS,
    });
    anonimizadas += filas.length;
    lotes += 1;
    if (filas.length < LOTE) break;
  }

  const truncado = lotes >= MAX_LOTES;
  if (anonimizadas > 0 || truncado) {
    logger.info(
      { anonimizadas, lotes, truncado, meses: PII_RETENTION_MONTHS, cutoff: cutoff.toISOString() },
      '[PiiRetention] Datos personales anonimizados por vencimiento del plazo de retención',
    );
  }
  return { anonimizadas, lotes, truncado };
}

/** Corre una vez por día. Se arranca al bootear el worker. */
export function startPiiRetentionLoop(): NodeJS.Timeout {
  return setInterval(() => {
    runPiiRetention().catch((err) =>
      logger.error({ error: (err as Error).message }, '[PiiRetention] La corrida diaria falló'),
    );
  }, INTERVALO_MS);
}
