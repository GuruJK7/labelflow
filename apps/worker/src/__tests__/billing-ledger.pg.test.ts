/**
 * Ledger contra Postgres REAL — opt-in.
 *
 * El fake en memoria (fake-ledger-db.ts) serializa TODAS las transacciones con
 * un mutex y su $queryRaw es un no-op, así que el test de 1000 operaciones
 * concurrentes no puede fallar por un bug de locking. Este archivo es la prueba
 * que sí puede: dos PrismaClient con pools independientes (= dos workers) contra
 * un Postgres de verdad, usando ledger.ts / ledger-prisma.ts sin modificar.
 *
 * SE SALTA si no está LEDGER_PG_URL. Cómo correrlo (docs/WALLET.md, "Test
 * contra Postgres real"):
 *
 *   1. Base descartable LOCAL con el schema completo + la migración del ledger:
 *        npx prisma migrate diff --from-empty \
 *          --to-schema-datamodel apps/web/prisma/schema.prisma --script > /tmp/full.sql
 *        psql "$URL" -v ON_ERROR_STOP=1 -f /tmp/full.sql
 *        psql "$URL" -v ON_ERROR_STOP=1 \
 *          -f apps/web/prisma/migrations/20260901180000_wallet_ledger/migration.sql
 *   2. LEDGER_PG_URL="$URL" node_modules/.bin/vitest run --root apps/worker \
 *          src/__tests__/billing-ledger.pg.test.ts
 *
 * 🔴 TRUNCA "WalletEntry", "Wallet", "Label", "Tenant" y "User" (CASCADE) en
 * cada test. Por eso sólo acepta hosts locales; para otro host hay que poner
 * además LEDGER_PG_ALLOW_REMOTE=1 y saber lo que se hace. NUNCA apuntarlo a
 * DATABASE_URL de prod.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  recordShipment,
  recordRefundForShipment,
  assertWalletInvariant,
  getOrCreateWalletForTenant,
  repairUnrecordedShipments,
  type LedgerClient,
} from '../billing/ledger';
import { prismaLedgerClient } from '../billing/ledger-prisma';
import { periodTotalMilli } from '../billing/tiers';
import { periodOf, shipmentIdemKey } from '../billing/settle';

const PG_URL = process.env.LEDGER_PG_URL;
const suite = PG_URL ? describe : describe.skip;
const TITLE = PG_URL
  ? 'ledger contra Postgres real'
  : 'ledger contra Postgres real (SALTADO: falta LEDGER_PG_URL — ver docs/WALLET.md)';

function assertLocalOrAllowed(url: string): void {
  const host = new URL(url).hostname;
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!local && process.env.LEDGER_PG_ALLOW_REMOTE !== '1') {
    throw new Error(
      `billing-ledger.pg.test: LEDGER_PG_URL apunta a "${host}" y este test TRUNCA tablas. ` +
        'Sólo hosts locales, salvo LEDGER_PG_ALLOW_REMOTE=1.',
    );
  }
}

const SEP = new Date('2026-09-10T15:00:00Z');
const AUG = new Date('2026-08-20T15:00:00Z');
const YM = periodOf(SEP);

// Dos "workers": dos PrismaClient con pools independientes. Se crean en
// beforeAll para que el archivo no abra conexiones cuando está salteado.
let p1: PrismaClient;
let p2: PrismaClient;
let w1: LedgerClient;
let w2: LedgerClient;

async function reset() {
  await p1.$executeRawUnsafe('TRUNCATE "WalletEntry", "Wallet", "Label", "Tenant", "User" CASCADE');
  await p1.$executeRawUnsafe(
    `INSERT INTO "User"("id", "email", "updatedAt") VALUES ('u1', 'u1@ledger.test', now()), ('u2', 'u2@ledger.test', now())`,
  );
  // apiKey tiene default cuid() del lado de Prisma, no de la base: hay que darlo.
  await p1.$executeRawUnsafe(
    `INSERT INTO "Tenant"("id", "userId", "name", "slug", "apiKey", "updatedAt") VALUES
       ('t1', 'u1', 't1', 't1', 'k-t1', now()),
       ('t2', 'u1', 't2', 't2', 'k-t2', now()),
       ('t3', 'u2', 't3', 't3', 'k-t3', now())`,
  );
}

async function insertLabel(id: string, tenantId: string, dacGuia: string, createdAt: Date) {
  await p1.label.create({
    data: {
      id,
      tenantId,
      shopifyOrderId: `so-${id}`,
      shopifyOrderName: `#${id}`,
      customerName: 'Cliente Prueba',
      deliveryAddress: 'Calle 1',
      city: 'Montevideo',
      department: 'Montevideo',
      totalUyu: 100,
      paymentType: 'DESTINATARIO',
      dacGuia,
      createdAt,
    },
  });
}

const settled = <T,>(ps: Promise<T>[]) => Promise.allSettled(ps);
const rejections = (rs: PromiseSettledResult<unknown>[]) =>
  rs
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => `${(r.reason as { code?: string })?.code ?? ''} ${String((r.reason as Error)?.message).slice(0, 120)}`);

suite(TITLE, () => {
  beforeAll(async () => {
    assertLocalOrAllowed(PG_URL as string);
    p1 = new PrismaClient({ datasources: { db: { url: PG_URL } } });
    p2 = new PrismaClient({ datasources: { db: { url: PG_URL } } });
    w1 = prismaLedgerClient(p1);
    w2 = prismaLedgerClient(p2);
    await reset();
  });
  beforeEach(reset);
  afterAll(async () => {
    await p1?.$disconnect();
    await p2?.$disconnect();
  });

  it('A. dos workers, mismo tenant, misma guía, 20 veces cada uno: 1 asiento, invariante', async () => {
    const ops = [];
    for (let i = 0; i < 20; i++) {
      ops.push(recordShipment(w1, { tenantId: 't1', dacGuia: 'G-1', at: SEP }));
      ops.push(recordShipment(w2, { tenantId: 't1', dacGuia: 'G-1', at: SEP }));
    }
    const rs = await settled(ops);
    expect(rejections(rs)).toEqual([]);
    const recorded = rs.filter((r) => r.status === 'fulfilled' && r.value.recorded).length;
    expect(recorded).toBe(1);
    expect(await p1.walletEntry.count({ where: { reason: 'shipment' } })).toBe(1);
    expect(await p1.walletEntry.count({ where: { reason: 'settlement' } })).toBe(1);
    const w = await getOrCreateWalletForTenant(w1, 't1');
    await assertWalletInvariant(w1, w.id, YM);
  });

  it('B. dos workers, guías distintas, 30 + 30 concurrentes al mismo wallet: n=60 y neto cierra', async () => {
    const ops = [];
    for (let i = 0; i < 30; i++) {
      ops.push(recordShipment(w1, { tenantId: 't1', dacGuia: `A-${i}`, at: SEP }));
      // misma numeración, otro tenant del mismo user: hecho distinto, mismo wallet
      ops.push(recordShipment(w2, { tenantId: 't2', dacGuia: `A-${i}`, at: SEP }));
    }
    const rs = await settled(ops);
    expect(rejections(rs)).toEqual([]);
    const w = await getOrCreateWalletForTenant(w1, 't1');
    const rep = await assertWalletInvariant(w1, w.id, YM);
    expect(rep.billableShipments).toBe(60);
    expect(rep.netMilli).toBe(-periodTotalMilli(60));
  });

  it('C. crash entre el asiento shipment y el settlement: rollback total', async () => {
    const crashy: LedgerClient = {
      ...w1,
      $transaction: (fn) =>
        w1.$transaction(async (tx) =>
          fn({
            ...tx,
            walletEntry: {
              ...tx.walletEntry,
              create: async (args) => {
                if (args.data.reason === 'settlement') throw new Error('simulated crash before settlement');
                return tx.walletEntry.create(args);
              },
            },
          }),
        ),
    };
    await expect(recordShipment(crashy, { tenantId: 't1', dacGuia: 'G-9', at: SEP })).rejects.toThrow('simulated');
    expect(await p1.walletEntry.count()).toBe(0);
    // el reintento limpio registra normal
    const ok = await recordShipment(w2, { tenantId: 't1', dacGuia: 'G-9', at: SEP });
    expect(ok.recorded).toBe(true);
    expect(await p1.walletEntry.count()).toBe(2);
  });

  it('D. reintegro concurrente con envíos nuevos (60 envíos previos, cruza tramo)', async () => {
    for (let i = 0; i < 60; i++) await recordShipment(w1, { tenantId: 't1', dacGuia: `G-${i}`, at: SEP });
    const ops: Promise<unknown>[] = [
      recordRefundForShipment(w2, { tenantId: 't1', dacGuia: 'G-5' }),
      recordShipment(w1, { tenantId: 't1', dacGuia: 'G-60', at: SEP }),
      recordRefundForShipment(w1, { tenantId: 't1', dacGuia: 'G-5' }),
      recordShipment(w2, { tenantId: 't1', dacGuia: 'G-61', at: SEP }),
      recordRefundForShipment(w2, { tenantId: 't1', dacGuia: 'G-6' }),
    ];
    const rs = await settled(ops);
    expect(rejections(rs)).toEqual([]);
    const w = await getOrCreateWalletForTenant(w1, 't1');
    const rep = await assertWalletInvariant(w1, w.id, YM);
    expect(rep.billableShipments).toBe(60 + 2 - 2);
    expect(await p1.walletEntry.count({ where: { reason: 'refund' } })).toBe(2);
    expect(rep.netMilli).toBe(-periodTotalMilli(60));
  });

  it('E. misma guía en dos users distintos: dos wallets, dos asientos', async () => {
    const [a, b] = await Promise.all([
      recordShipment(w1, { tenantId: 't1', dacGuia: 'G-777', at: SEP }),
      recordShipment(w2, { tenantId: 't3', dacGuia: 'G-777', at: SEP }),
    ]);
    expect(a.recorded && b.recorded).toBe(true);
    expect(await p1.wallet.count()).toBe(2);
    expect(await p1.walletEntry.count({ where: { reason: 'shipment' } })).toBe(2);
  });

  it('F. índice parcial de verdad: insert directo duplicado con otro idemKey → P2002; reason inválido → CHECK', async () => {
    await recordShipment(w1, { tenantId: 't1', dacGuia: 'G-1', at: SEP });
    const w = await getOrCreateWalletForTenant(w1, 't1');
    await expect(
      p1.walletEntry.create({
        data: { walletId: w.id, tenantId: 't1', deltaMilli: 0n, reason: 'shipment', idemKey: 'ship:v0:otra-clave', dacGuia: 'G-1', periodYm: YM },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      p1.walletEntry.create({
        data: { walletId: w.id, tenantId: null, deltaMilli: 0n, reason: 'typo', idemKey: 'x', periodYm: YM },
      }),
    ).rejects.toThrow();
  });

  it('G. carrera en la creación del wallet: 10 concurrentes, 1 wallet', async () => {
    const rs = await settled(
      Array.from({ length: 10 }, (_, i) =>
        recordShipment(i % 2 ? w1 : w2, { tenantId: i % 3 ? 't1' : 't2', dacGuia: `W-${i}`, at: SEP }),
      ),
    );
    expect(rejections(rs)).toEqual([]);
    expect(await p1.wallet.count()).toBe(1);
  });

  it('H. 120 concurrentes sobre el mismo wallet: 0 timeouts con maxWait 5 s / timeout 15 s', async () => {
    const N = 120;
    const t0 = Date.now();
    const rs = await settled(
      Array.from({ length: N }, (_, i) => recordShipment(i % 2 ? w1 : w2, { tenantId: 't1', dacGuia: `H-${i}`, at: SEP })),
    );
    const rejected = rejections(rs);
    // eslint-disable-next-line no-console
    console.log(`H: N=${N} en ${Date.now() - t0}ms, rechazadas=${rejected.length}`, [...new Set(rejected)].slice(0, 3));
    expect(rejected).toEqual([]);
    const w = await getOrCreateWalletForTenant(w1, 't1');
    const rep = await assertWalletInvariant(w1, w.id, YM);
    expect(rep.billableShipments).toBe(N);
  });

  it('I. repairUnrecordedShipments: asienta la Label con guía real sin asiento, en el período de createdAt; la 2ª corrida es no-op', async () => {
    await insertLabel('l-aug', 't1', 'R-1', AUG); // guía real de agosto, sin asiento (el hook no corrió)
    await insertLabel('l-sep', 't1', 'R-2', SEP); // guía real ya asentada por el hook
    await insertLabel('l-pend', 't2', 'PENDING-9', SEP); // placeholder: no facturable
    await insertLabel('l-otro', 't3', 'R-3', SEP); // otro user, sin asiento
    await recordShipment(w1, { tenantId: 't1', dacGuia: 'R-2', at: SEP });

    const first = await repairUnrecordedShipments(w2, { limit: 50 });
    expect(first).toMatchObject({ scanned: 4, repaired: 2, alreadyRecorded: 1, notBillable: 1, exhausted: true });
    expect(first.repairedLabelIds.sort()).toEqual(['l-aug', 'l-otro']);

    const aug = await p1.walletEntry.findUnique({ where: { idemKey: shipmentIdemKey('t1', 'R-1') } });
    expect(aug?.periodYm).toBe(periodOf(AUG));
    expect(aug?.labelId).toBe('l-aug');
    const before = await p1.walletEntry.count();

    const second = await repairUnrecordedShipments(w1, { limit: 50 });
    expect(second).toMatchObject({ repaired: 0, alreadyRecorded: 3, notBillable: 1, exhausted: true });
    expect(await p1.walletEntry.count()).toBe(before);

    const w = await getOrCreateWalletForTenant(w1, 't1');
    await assertWalletInvariant(w1, w.id, periodOf(AUG));
    await assertWalletInvariant(w1, w.id, YM);
  });
});
