/**
 * Retención de `RunLog` — lo que hace que la base deje de crecer para siempre.
 *
 * 🔴 POR QUÉ EXISTE. Medido el 2026-09-08 contra producción: la base pesaba
 * **769 MB** contra un límite de plan de 500 MB, y **697 MB de eso era esta
 * tabla** (1.622.366 filas, el 91% de la base). El 99% son la traza paso a paso
 * del navegador de DAC —`[nav:new-shipment]`, `[step1:tipo-guia]`,
 * `[submit:extract-guia]`— que se escribe en cada despacho y que **nadie
 * borraba nunca**: había retención de PDFs (15 días) y de datos personales
 * (24 meses), de `RunLog` ninguna. Crecía ~16 MB/día.
 *
 * 🔴 POR QUÉ NO SE DEJAN DE ESCRIBIR. Fue la primera idea y está mal: el panel
 * "En vivo" del dashboard (`ShipmentInsights`, alimentado por
 * `/api/v1/insights`) se dibuja EXACTAMENTE con esas trazas INFO del job en
 * curso. Apagarlas deja la pantalla en blanco justo cuando Adrian mira correr
 * un lote. Así que se siguen escribiendo — y caducan.
 *
 * LA REGLA, en tres cajones:
 *
 *   1. Traza de pasos INFO/SUCCESS  → se va a los TRAZA_DIAS (7 por defecto).
 *      Es el 96% del volumen y su única razón de ser es el feed en vivo, que
 *      sólo mira el job actual.
 *   2. Traza WARN/ERROR             → se va a los TRAZA_ERROR_DIAS (30). Es
 *      poco volumen y es lo que se lee cuando hay que entender qué falló.
 *   3. Mensajes de negocio          → **NO SE BORRAN NUNCA.** Son los que no
 *      empiezan con `[`: `reconcile-shopify`, `label-manual-pdf-upload`, los
 *      `maxOrdersOverride`. 16.219 filas, 3,5 MB en total. No mueven la aguja
 *      del espacio y sí son historia real.
 *
 * 🔴 LA EXCEPCIÓN QUE CASI ME COMO. `/api/v1/chat/report` lee reportes de
 * usuarios de esta misma tabla filtrando `message.startsWith('[')` + BUG
 * REPORT / FEEDBACK / AYUDA. O sea: hay mensajes con corchete que NO son traza
 * y son de personas. Hoy no hay ninguno guardado, pero la feature existe, así
 * que se excluyen por nombre — no por "hoy no hay".
 *
 * IDEMPOTENTE Y CORTABLE. Borra por lotes de ids; una fila borrada no vuelve a
 * matchear, así que el bucle termina solo y una corrida cortada no rompe nada.
 * El tope por corrida evita que la primera acaparé un tick entero.
 *
 * NO TOCA NADA EN VUELO: con una ventana de 7 días, ningún job en curso tiene
 * logs tan viejos.
 */
import { db } from '../db';
import logger from '../logger';

const dias = (nombre: string, porDefecto: number): number => {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : porDefecto;
};

/** Días que vive la traza de pasos normal (INFO/SUCCESS). */
export const TRAZA_DIAS = dias('RUNLOG_TRAZA_DIAS', 7);
/** Días que vive la traza de fallas (WARN/ERROR): más, porque es la que se lee. */
export const TRAZA_ERROR_DIAS = dias('RUNLOG_TRAZA_ERROR_DIAS', 30);

/**
 * Mensajes que arrancan con `[` pero NO son traza: los escribe una persona
 * desde el chat de soporte y los lee `/api/v1/chat/report`. Nunca se borran.
 */
export const MENSAJES_PROTEGIDOS = ['BUG REPORT', 'FEEDBACK', 'AYUDA'] as const;

const NIVELES_TRAZA = ['INFO', 'SUCCESS'] as const;
const NIVELES_FALLA = ['WARN', 'ERROR'] as const;

export const LOTE = 5000;
/**
 * Tope por corrida. Dimensionado para que la PRIMERA corrida se coma el atraso
 * entero de una: el 08-09 había 1.455.011 filas vencidas. Después de eso, una
 * corrida diaria normal borra ~17.000 y termina en 4 lotes.
 */
export const MAX_LOTES = 400;
const INTERVALO_MS = 24 * 60 * 60 * 1000; // una vez por día

const menos = (now: Date, d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

/**
 * El filtro completo. Se exporta para que el test lo pueda leer sin correr el
 * job: es la parte del código donde un error se paga borrando datos.
 */
export function filtroDeBorrado(now: Date) {
  return {
    message: { startsWith: '[' },
    AND: MENSAJES_PROTEGIDOS.map((m) => ({ message: { not: { contains: m } } })),
    OR: [
      { level: { in: [...NIVELES_TRAZA] }, createdAt: { lt: menos(now, TRAZA_DIAS) } },
      { level: { in: [...NIVELES_FALLA] }, createdAt: { lt: menos(now, TRAZA_ERROR_DIAS) } },
    ],
  };
}

export interface ResultadoRetencionRunLog {
  borradas: number;
  lotes: number;
  truncado: boolean;
}

export async function runRunLogRetention(now = new Date()): Promise<ResultadoRetencionRunLog> {
  const where = filtroDeBorrado(now);
  let borradas = 0;
  let lotes = 0;

  while (lotes < MAX_LOTES) {
    const filas = await db.runLog.findMany({ where, select: { id: true }, take: LOTE });
    if (filas.length === 0) break;

    const { count } = await db.runLog.deleteMany({ where: { id: { in: filas.map((f) => f.id) } } });
    borradas += count;
    lotes += 1;
    if (filas.length < LOTE) break;
  }

  const truncado = lotes >= MAX_LOTES;
  if (borradas > 0 || truncado) {
    logger.info(
      { borradas, lotes, truncado, trazaDias: TRAZA_DIAS, errorDias: TRAZA_ERROR_DIAS },
      '[RunLogRetention] Traza vencida borrada (los mensajes de negocio no se tocan)',
    );
  }
  return { borradas, lotes, truncado };
}

/** Corre una vez por día. Se arranca al bootear el worker. */
export function startRunLogRetentionLoop(): NodeJS.Timeout {
  return setInterval(() => {
    runRunLogRetention().catch((err) =>
      logger.error({ error: (err as Error).message }, '[RunLogRetention] La corrida diaria falló'),
    );
  }, INTERVALO_MS);
}
