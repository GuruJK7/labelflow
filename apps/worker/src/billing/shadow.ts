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
    logger.warn(
      { tenantId: input.tenantId, guia: input.dacGuia, err: (err as Error)?.message },
      'wallet-shadow: no se pudo asentar el envío; el job sigue',
    );
  }
}
