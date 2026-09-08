import pino from 'pino';
import { db } from './db';
import type { DacStep } from './dac/steps';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
});

export default logger;

/**
 * Freno de emergencia para el peso de `RunLog`.
 *
 * El tamaño de la tabla lo acota `runlog-retention.job.ts` (la traza caduca a
 * los 7 días). Esto es el otro lado: cortar la ESCRITURA si alguna vez hace
 * falta bajar el ritmo ya mismo —lo que se escribe en la base baja ~89% con
 * `RUNLOG_MIN_LEVEL=SUCCESS`, porque el 96% de las filas son INFO—.
 *
 * 🔴 EL DEFAULT ES `INFO`, o sea: NO CAMBIA NADA hoy. Es a propósito. Subirlo
 * VACÍA el panel "En vivo" del dashboard, que se dibuja con esas trazas INFO
 * (`ShipmentInsights` ← `/api/v1/insights`). Los pasos siguen yendo siempre a
 * los logs de Render, así que subir esto no pierde capacidad de depurar: pierde
 * la pantallita en vivo. Es un lever para una emergencia, no una optimización
 * para dejar puesta.
 */
const RANGO_NIVEL = { INFO: 10, SUCCESS: 20, WARN: 30, ERROR: 40 } as const;
type NivelRunLog = keyof typeof RANGO_NIVEL;

const NIVEL_MINIMO_DB: number = (() => {
  const bruto = (process.env.RUNLOG_MIN_LEVEL ?? 'INFO').trim().toUpperCase();
  return RANGO_NIVEL[bruto as NivelRunLog] ?? RANGO_NIVEL.INFO;
})();

export function sePersisteEnDb(level: NivelRunLog): boolean {
  return RANGO_NIVEL[level] >= NIVEL_MINIMO_DB;
}

/**
 * Step logger that writes to both console (pino) AND RunLog DB table.
 * Every micro-action in the DAC flow is captured for debugging.
 */
export interface StepLogger {
  info(step: DacStep | string, message: string, meta?: Record<string, unknown>): void;
  warn(step: DacStep | string, message: string, meta?: Record<string, unknown>): void;
  error(step: DacStep | string, message: string, meta?: Record<string, unknown>): void;
  success(step: DacStep | string, message: string, meta?: Record<string, unknown>): void;
}

export function createStepLogger(jobId: string, tenantId: string): StepLogger {
  const writeToDB = (level: NivelRunLog, step: string, message: string, meta?: Record<string, unknown>) => {
    // La consola (pino) SIEMPRE recibe todo; el freno es sólo para la base.
    if (!sePersisteEnDb(level)) return;
    const fullMessage = `[${step}] ${message}`;
    db.runLog.create({
      data: {
        tenantId,
        jobId,
        level,
        message: fullMessage,
        meta: { step, ...meta } as any,
      },
    }).catch(() => {
      // DB write failure should never crash the worker
    });
  };

  return {
    info(step, message, meta) {
      logger.info({ step, jobId, tenantId, ...meta }, message);
      writeToDB('INFO', step, message, meta);
    },
    warn(step, message, meta) {
      logger.warn({ step, jobId, tenantId, ...meta }, message);
      writeToDB('WARN', step, message, meta);
    },
    error(step, message, meta) {
      logger.error({ step, jobId, tenantId, ...meta }, message);
      writeToDB('ERROR', step, message, meta);
    },
    success(step, message, meta) {
      logger.info({ step, jobId, tenantId, ...meta }, message);
      writeToDB('SUCCESS', step, message, meta);
    },
  };
}
