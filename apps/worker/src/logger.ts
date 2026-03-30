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
  const writeToDB = (level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', step: string, message: string, meta?: Record<string, unknown>) => {
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
