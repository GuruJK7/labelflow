import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FakeLedgerDb } from './helpers/fake-ledger-db';

// El hook usa el `db` real vía prismaLedgerClient. Acá `db` es el fake, así
// que el test cubre el adaptador (mismos nombres de método que PrismaClient)
// y la política del hook: apagado por default, nunca lanza.
vi.mock('../db', async () => {
  const { FakeLedgerDb } = await import('./helpers/fake-ledger-db');
  return { db: new FakeLedgerDb() };
});
// El logger real importa ../db y escribe RunLog; acá sólo importa QUÉ nivel
// usa el hook cuando el ledger falla (error vs warn), así que se espía.
vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { db } from '../db';
import logger from '../logger';
import { shadowRecordShipment, walletShadowEnabled } from '../billing/shadow';
import { periodOf } from '../billing/settle';
import { FakeP2002 } from './helpers/fake-ledger-db';

const fake = db as unknown as FakeLedgerDb;
const log = logger as unknown as { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

const original = process.env.WALLET_SHADOW;

beforeEach(() => {
  fake.tenants.clear();
  fake.wallets = [];
  fake.entries = [];
  fake.transactionsRun = 0;
  fake.seedTenant('t-1', 'u-1');
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
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

  it('pasa `at` al ledger: el período contable es el del hecho, no el de hoy', async () => {
    process.env.WALLET_SHADOW = '1';
    const AUG = new Date('2026-08-20T15:00:00Z');
    await shadowRecordShipment({ tenantId: 't-1', dacGuia: '123', labelId: 'l', jobId: 'j', at: AUG });
    // `at` inválido o ausente cae en "ahora", nunca rompe el hook
    await shadowRecordShipment({ tenantId: 't-1', dacGuia: '456', labelId: 'l2', jobId: 'j', at: new Date('nope') });
    await shadowRecordShipment({ tenantId: 't-1', dacGuia: '789', labelId: 'l3', jobId: 'j', at: null });
    const byGuia = (g: string) => fake.entries.find((e) => e.reason === 'shipment' && e.dacGuia === g);
    expect(byGuia('123')?.periodYm).toBe(periodOf(AUG));
    expect(byGuia('456')?.periodYm).toBe(periodOf(new Date()));
    expect(byGuia('789')?.periodYm).toBe(periodOf(new Date()));
  });
});

describe('shadowRecordShipment — nivel de log cuando el ledger falla', () => {
  const MSG = 'wallet-shadow: no se pudo asentar'; // lo grepea el chequeo de humo (docs/WALLET.md)

  it('error sin código (DB caída): nivel error, no warn', async () => {
    process.env.WALLET_SHADOW = '1';
    fake.failNextCreates = 1;
    await shadowRecordShipment({ tenantId: 't-1', dacGuia: '999' });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    const [ctx, msg] = log.error.mock.calls[0];
    expect(msg).toContain(MSG);
    expect(ctx).toMatchObject({ tenantId: 't-1', guia: '999', code: undefined });
    expect(ctx.err).toContain('simulated');
  });

  it('P2021 (tabla inexistente): nivel error y nombra la migración wallet_ledger', async () => {
    process.env.WALLET_SHADOW = '1';
    const orig = fake.wallet.findUnique;
    fake.wallet.findUnique = async () => {
      throw Object.assign(new Error('The table `public.Wallet` does not exist in the current database.'), { code: 'P2021' });
    };
    try {
      await expect(shadowRecordShipment({ tenantId: 't-1', dacGuia: '999' })).resolves.toBeUndefined();
    } finally {
      fake.wallet.findUnique = orig;
    }
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    const [ctx, msg] = log.error.mock.calls[0];
    expect(ctx).toMatchObject({ code: 'P2021' });
    expect(msg).toContain(MSG);
    expect(msg).toContain('migración wallet_ledger no aplicada');
  });

  it('P2002 (unique ajena al ledger): sigue siendo warn, con code', async () => {
    process.env.WALLET_SHADOW = '1';
    const origCreate = fake.wallet.create;
    // getOrCreateWalletForTenant relee tras un P2002; si tampoco encuentra, relanza.
    fake.wallet.create = async () => {
      throw new FakeP2002({ target: ['userId'] });
    };
    try {
      await expect(shadowRecordShipment({ tenantId: 't-1', dacGuia: '999' })).resolves.toBeUndefined();
    } finally {
      fake.wallet.create = origCreate;
    }
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = log.warn.mock.calls[0];
    expect(ctx).toMatchObject({ code: 'P2002' });
    expect(msg).toContain(MSG);
  });
});
