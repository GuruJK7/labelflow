/**
 * Hook de MODO SOMBRA del ledger. Se llama desde cada job que persiste una
 * guía DAC real en Label.dacGuia, justo después del upsert exitoso.
 *
 * Reglas:
 *   - Apagado por default. Se prende con WALLET_SHADOW=1.
 *   - NUNCA lanza. Si el ledger falla, se loguea y el job sigue como si nada:
 *     la guía ya existe, y el cobro real (deductCreditsAndStamp) no depende
 *     de esto.
 *   - No filtra guías: recordShipment ya ignora PENDING-/TEST-/LF-.
 */

import { db } from '../db';
import logger from '../logger';
import { recordShipment } from './ledger';
import { prismaLedgerClient } from './ledger-prisma';

export function walletShadowEnabled(): boolean {
  return process.env.WALLET_SHADOW === '1';
}

export interface ShadowShipmentInput {
  tenantId: string;
  dacGuia: string | null | undefined;
  labelId?: string | null;
  jobId?: string | null;
  /**
   * Momento del hecho (Label.createdAt). Define el período contable: una guía
   * recuperada por orphan-reconcile a los 30 min de emitida, o reparada
   * semanas después, se asienta en el mes en que existió, no en el que se
   * asentó. Si no viene, el ledger usa "ahora".
   */
  at?: Date | null;
}

export async function shadowRecordShipment(input: ShadowShipmentInput): Promise<void> {
  try {
    if (!walletShadowEnabled()) return;
    if (!input.dacGuia) return;
    const result = await recordShipment(prismaLedgerClient(db), {
      tenantId: input.tenantId,
      dacGuia: input.dacGuia,
      labelId: input.labelId ?? null,
      jobId: input.jobId ?? null,
      at: input.at instanceof Date && !Number.isNaN(input.at.getTime()) ? input.at : undefined,
    });
    if (result.recorded) {
      logger.info(
        {
          tenantId: input.tenantId,
          guia: input.dacGuia,
          walletId: result.walletId,
          periodYm: result.periodYm,
          billable: result.settlement.billableShipments,
          deltaMilli: result.settlement.deltaMilli.toString(),
        },
        'wallet-shadow: envío asentado',
      );
    } else if (result.alreadyRecorded) {
      logger.info(
        { tenantId: input.tenantId, guia: input.dacGuia },
        'wallet-shadow: la guía ya estaba asentada (no-op)',
      );
    }
  } catch (err) {
    // Todos los mensajes conservan el prefijo 'wallet-shadow: no se pudo asentar'
    // porque el chequeo de humo del primer día (docs/WALLET.md) grepea eso.
    const code = (err as { code?: unknown })?.code;
    const ctx = {
      tenantId: input.tenantId,
      guia: input.dacGuia,
      code: typeof code === 'string' ? code : undefined,
      err: (err as Error)?.message,
    };
    if (code === 'P2002') {
      // recordShipment ya lo absorbe; si llega acá es una unique que no es
      // la del ledger. Ruido, no divergencia.
      logger.warn(ctx, 'wallet-shadow: no se pudo asentar el envío (unique); el job sigue');
    } else if (code === 'P2021') {
      logger.error(
        ctx,
        'wallet-shadow: no se pudo asentar el envío — migración wallet_ledger no aplicada (P2021: la tabla no existe); el job sigue',
      );
    } else {
      // Nivel error a propósito: cada línea es un envío que la sombra NO vio y
      // que después se lee como divergencia. Que no quede mudo en un warn.
      logger.error(ctx, 'wallet-shadow: no se pudo asentar el envío; el job sigue');
    }
  }
}
