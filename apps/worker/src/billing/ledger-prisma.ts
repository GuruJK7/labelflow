/**
 * Adaptador PrismaClient → LedgerClient.
 *
 * Es un envoltorio explícito y no un cast porque los tipos de Prisma
 * (`SelectSubset<T, …>`) no son estructuralmente comparables con la interfaz
 * angosta del ledger: `db as LedgerClient` no compila, y `as unknown as`
 * tiraría a la basura el chequeo de tipos justo en las llamadas que tocan
 * plata. Con el envoltorio, cada llamada real queda verificada contra el
 * cliente generado.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import type { LedgerClient, LedgerTx } from './ledger';

type Queryable = PrismaClient | Prisma.TransactionClient;

function txOf(p: Queryable): LedgerTx {
  return {
    $queryRaw: (query, ...values) => p.$queryRaw(query, ...values),
    wallet: {
      findUnique: (args) => p.wallet.findUnique(args),
      update: (args) => p.wallet.update(args),
    },
    walletEntry: {
      findUnique: (args) => p.walletEntry.findUnique(args),
      create: (args) => p.walletEntry.create(args),
      count: (args) => p.walletEntry.count(args),
      aggregate: (args) => p.walletEntry.aggregate(args),
    },
  };
}

export function prismaLedgerClient(prisma: PrismaClient): LedgerClient {
  return {
    tenant: {
      findUnique: (args) => prisma.tenant.findUnique(args),
    },
    wallet: {
      findUnique: (args) => prisma.wallet.findUnique(args),
      create: (args) => prisma.wallet.create(args),
    },
    $transaction: (fn) => prisma.$transaction((tx) => fn(txOf(tx))),
  };
}
