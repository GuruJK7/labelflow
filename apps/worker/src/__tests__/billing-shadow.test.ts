import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FakeLedgerDb } from './helpers/fake-ledger-db';

// El hook usa el `db` real vía prismaLedgerClient. Acá `db` es el fake, así
// que el test cubre el adaptador (mismos nombres de método que PrismaClient)
// y la política del hook: apagado por default, nunca lanza.
vi.mock('../db', async () => {
  const { FakeLedgerDb } = await import('./helpers/fake-ledger-db');
  return { db: new FakeLedgerDb() };
});

import { db } from '../db';
import { shadowRecordShipment, walletShadowEnabled } from '../billing/shadow';

const fake = db as unknown as FakeLedgerDb;

const original = process.env.WALLET_SHADOW;

beforeEach(() => {
  fake.tenants.clear();
  fake.wallets = [];
  fake.entries = [];
  fake.transactionsRun = 0;
  fake.seedTenant('t-1', 'u-1');
});
afterEach(() => {
  if (original === undefined) delete process.env.WALLET_SHADOW;
  else process.env.WALLET_SHADOW = original;
});

describe('shadowRecordShipment', () => {
  it('apagado por default: no toca la base', async () => {
    delete process.env.WALLET_SHADOW;
    expect(walletShadowEnabled()).toBe(false);
    await shadowRecordShipment({ tenantId: 't-1', dacGuia: '123', labelId: 'l', jobId: 'j' });
    expect(fake.transactionsRun).toBe(0);
    expect(fake.entries).toHaveLength(0);
  });

  it('con WALLET_SHADOW=1 asienta la guía real y salta PENDING-', async () => {
    process.env.WALLET_SHADOW = '1';
    await shadowRecordShipment({ tenantId: 't-1', dacGuia: 'PENDING-x', labelId: 'l', jobId: 'j' });
    expect(fake.entries).toHaveLength(0);
    await shadowRecordShipment({ tenantId: 't-1', dacGuia: '123', labelId: 'l', jobId: 'j' });
    await shadowRecordShipment({ tenantId: 't-1', dacGuia: '123', labelId: 'l', jobId: 'j' });
    expect(fake.entries.filter((e) => e.reason === 'shipment')).toHaveLength(1);
    expect(fake.wallets[0].balanceMilli).toBe(0n);
  });

  it('nunca lanza aunque el ledger explote (tenant inexistente, DB caída)', async () => {
    process.env.WALLET_SHADOW = '1';
    await expect(
      shadowRecordShipment({ tenantId: 't-no-existe', dacGuia: '123' }),
    ).resolves.toBeUndefined();
    fake.failNextCreates = 1;
    await expect(shadowRecordShipment({ tenantId: 't-1', dacGuia: '999' })).resolves.toBeUndefined();
    expect(fake.entries).toHaveLength(0);
  });
});
