import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordShipment,
  recordRefundForShipment,
  assertWalletInvariant,
  getOrCreateWalletForTenant,
  repairUnrecordedShipments,
  isBillableGuia,
  type LedgerTx,
} from '../billing/ledger';
import { periodTotalMilli, unitPriceFor, uyu } from '../billing/tiers';
import { periodOf, shipmentIdemKey } from '../billing/settle';
import { FakeLedgerDb } from './helpers/fake-ledger-db';

const SEP = new Date('2026-09-10T15:00:00Z'); // 2026-09 en UY
const AUG = new Date('2026-08-20T15:00:00Z'); // 2026-08 en UY
const YM_SEP = periodOf(SEP);
const YM_AUG = periodOf(AUG);

let db: FakeLedgerDb;

beforeEach(() => {
  db = new FakeLedgerDb();
  db.seedTenant('t-aura', 'u-jk');
  db.seedTenant('t-aura-2', 'u-jk'); // segunda tienda del mismo user
  db.seedTenant('t-otro', 'u-otro');
});

async function ship(tenantId: string, guia: string, at = SEP) {
  return recordShipment(db, { tenantId, dacGuia: guia, labelId: `lbl-${guia}`, jobId: 'job-1', at });
}

describe('ledger — asiento por envío (modo sombra)', () => {
  it('emisión falla 3 veces y luego funciona: exactamente 1 asiento', async () => {
    // (a) DAC no devolvió guía tres veces: el job persiste PENDING-, no hay hecho facturable.
    for (let i = 0; i < 3; i++) {
      const r = await ship('t-aura', `PENDING-${i}`);
      expect(r.recorded).toBe(false);
    }
    expect(db.entries).toHaveLength(0);

    // (b) La guía salió pero la DB del ledger se cae tres veces al escribir.
    db.failNextCreates = 3;
    for (let i = 0; i < 3; i++) {
      await expect(ship('t-aura', 'G-1')).rejects.toThrow('simulated');
      expect(db.entries).toHaveLength(0); // rollback: ni shipment ni settlement a medias
    }

    const ok = await ship('t-aura', 'G-1');
    expect(ok.recorded).toBe(true);
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    expect(db.entriesOf(w.id, 'shipment')).toHaveLength(1);
    expect(db.entriesOf(w.id, 'settlement')).toHaveLength(1);
    expect(db.netOf(w.id, YM_SEP)).toBe(-uyu(20));
    await assertWalletInvariant(db, w.id, YM_SEP);
  });

  it('misma guía dos veces: 1 asiento y la segunda es no-op', async () => {
    const first = await ship('t-aura', 'G-1');
    const second = await ship('t-aura', 'G-1');
    expect(first.recorded).toBe(true);
    expect(second).toMatchObject({ recorded: false, alreadyRecorded: true });
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    expect(db.entriesOf(w.id, 'shipment')).toHaveLength(1);
    expect(db.entriesOf(w.id, 'settlement')).toHaveLength(1); // delta 0 → no se emite otra
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(1));
  });

  it('misma guía en 2 tenants de users distintos: 2 asientos, un wallet cada uno', async () => {
    const a = await ship('t-aura', 'G-777');
    const b = await ship('t-otro', 'G-777');
    expect(a.recorded && b.recorded).toBe(true);
    const wa = await getOrCreateWalletForTenant(db, 't-aura');
    const wb = await getOrCreateWalletForTenant(db, 't-otro');
    expect(wa.id).not.toBe(wb.id);
    expect(db.entriesOf(wa.id, 'shipment')).toHaveLength(1);
    expect(db.entriesOf(wb.id, 'shipment')).toHaveLength(1);
    expect(db.netOf(wa.id, YM_SEP)).toBe(-uyu(20));
    expect(db.netOf(wb.id, YM_SEP)).toBe(-uyu(20));
  });

  it('dos tiendas del mismo user comparten wallet y volumen', async () => {
    await ship('t-aura', 'G-1');
    await ship('t-aura-2', 'G-1'); // misma numeración DAC, otra cuenta: hecho distinto
    const w = await getOrCreateWalletForTenant(db, 't-aura-2');
    expect(db.wallets).toHaveLength(1);
    expect(db.entriesOf(w.id, 'shipment')).toHaveLength(2);
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(2));
  });

  it('cruzar un tramo re-liquida el mes entero (nunca más que el techo del tramo siguiente)', async () => {
    for (let i = 1; i <= 49; i++) await ship('t-aura', `G-${i}`);
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    // 49 envíos al precio de su propio tramo salen más que el total del tramo
    // de 50, así que se cobra el techo. Los montos se derivan del tarifario a
    // propósito: el test verifica el COMPORTAMIENTO, no una tabla de precios.
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(50));
    await ship('t-aura', 'G-50');
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(50));
    await ship('t-aura', 'G-51');
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(51));
    expect(periodTotalMilli(51)).toBe(51n * unitPriceFor(51)); // ya no está en el techo
    await assertWalletInvariant(db, w.id, YM_SEP);
  });

  it('un período por mes: septiembre no toca agosto', async () => {
    await ship('t-aura', 'G-A', AUG);
    await ship('t-aura', 'G-S', SEP);
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    expect(db.netOf(w.id, YM_AUG)).toBe(-uyu(20));
    expect(db.netOf(w.id, YM_SEP)).toBe(-uyu(20));
    await assertWalletInvariant(db, w.id, YM_AUG);
    await assertWalletInvariant(db, w.id, YM_SEP);
  });

  it('se auto-repara: si falta una liquidación, el próximo evento la corrige', async () => {
    for (let i = 1; i <= 5; i++) await ship('t-aura', `G-${i}`);
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    // Alguien borró a mano un settlement (o quedó perdido): el neto ya no cierra.
    const idx = db.entries.findIndex((e) => e.reason === 'settlement');
    db.entries.splice(idx, 1);
    await expect(assertWalletInvariant(db, w.id, YM_SEP)).rejects.toThrow('Invariante');
    await ship('t-aura', 'G-6');
    await assertWalletInvariant(db, w.id, YM_SEP);
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(6));
  });
});

describe('ledger — reintegros', () => {
  it('reintegro deja el período en -periodTotal(n-1)', async () => {
    const N = 60; // arriba del tramo de 50 para que el reintegro mueva precio
    for (let i = 1; i <= N; i++) await ship('t-aura', `G-${i}`);
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(N));

    const r = await recordRefundForShipment(db, { tenantId: 't-aura', dacGuia: 'G-7' });
    expect(r.refunded).toBe(true);
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(N - 1));
    await assertWalletInvariant(db, w.id, YM_SEP);
  });

  it('reintegrar dos veces la misma guía es no-op', async () => {
    await ship('t-aura', 'G-1');
    await ship('t-aura', 'G-2');
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    const a = await recordRefundForShipment(db, { tenantId: 't-aura', dacGuia: 'G-1' });
    const b = await recordRefundForShipment(db, { tenantId: 't-aura', dacGuia: 'G-1' });
    expect(a.refunded).toBe(true);
    expect(b).toMatchObject({ refunded: false, alreadyRecorded: true });
    expect(db.entriesOf(w.id, 'refund')).toHaveLength(1);
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(1));
  });

  it('reintegro de una guía que nunca se asentó: no-op explícito', async () => {
    const r = await recordRefundForShipment(db, { tenantId: 't-aura', dacGuia: 'G-nunca' });
    expect(r).toMatchObject({ refunded: false, reason: 'no_shipment' });
    expect(db.entries).toHaveLength(0);
  });

  it('reintegrar en septiembre una guía de agosto corrige agosto, no septiembre', async () => {
    await ship('t-aura', 'G-A1', AUG);
    await ship('t-aura', 'G-A2', AUG);
    await ship('t-aura', 'G-S1', SEP);
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    await recordRefundForShipment(db, { tenantId: 't-aura', dacGuia: 'G-A1' });
    expect(db.netOf(w.id, YM_AUG)).toBe(-periodTotalMilli(1));
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(1));
    await assertWalletInvariant(db, w.id, YM_AUG);
    await assertWalletInvariant(db, w.id, YM_SEP);
  });
});

describe('ledger — concurrencia', () => {
  it('1000 operaciones aleatorias concurrentes mantienen el invariante', async () => {
    // PRNG determinista: si falla, se reproduce.
    let seed = 20260901;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const tenants = ['t-aura', 't-aura-2', 't-otro'];
    const dates = [AUG, SEP];
    const shipped = new Set<string>();
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 1000; i++) {
      const tenantId = tenants[Math.floor(rnd() * tenants.length)];
      const guia = `G-${Math.floor(rnd() * 120)}`; // pool chico → muchos duplicados
      const at = dates[Math.floor(rnd() * dates.length)];
      const roll = rnd();
      if (roll < 0.15) {
        ops.push(recordRefundForShipment(db, { tenantId, dacGuia: guia }));
      } else if (roll < 0.2) {
        ops.push(recordShipment(db, { tenantId, dacGuia: `PENDING-${i}`, at }));
      } else {
        shipped.add(`${tenantId}|${guia}`);
        ops.push(recordShipment(db, { tenantId, dacGuia: guia, at }));
      }
    }
    await Promise.all(ops);

    // Un asiento 'shipment' por (tenant, guía) que efectivamente se despachó.
    const shipmentEntries = db.entries.filter((e) => e.reason === 'shipment');
    const keys = new Set(shipmentEntries.map((e) => `${e.tenantId}|${e.dacGuia}`));
    expect(keys.size).toBe(shipmentEntries.length);
    expect(keys.size).toBe(shipped.size);
    expect(db.wallets).toHaveLength(2);

    for (const w of db.wallets) {
      for (const ym of [YM_AUG, YM_SEP]) {
        const rep = await assertWalletInvariant(db, w.id, ym);
        expect(rep.netMilli).toBe(-periodTotalMilli(rep.billableShipments));
      }
      expect(w.balanceMilli).toBe(0n); // sombra
    }
  });
});

describe('ledger — contrato de lock (FOR UPDATE primero)', () => {
  /**
   * El fake serializa todo con un mutex, así que un bug de locking no rompe
   * el test de 1000 operaciones. Este espía mira ADENTRO de cada transacción
   * y afirma que la primera sentencia es el SELECT … FOR UPDATE sobre "Wallet".
   * Si alguien borra lockWallet(), lo cambia por un SELECT común o lo mueve
   * después de una lectura, esto falla.
   */
  function spyTransactions(fake: FakeLedgerDb): string[][] {
    const perTx: string[][] = [];
    const original = fake.$transaction.bind(fake);
    fake.$transaction = <T,>(fn: (tx: LedgerTx) => Promise<T>) =>
      original(async (tx) => {
        const ops: string[] = [];
        perTx.push(ops);
        const rec =
          <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
          (...a: A): R => {
            ops.push(name);
            return f(...a);
          };
        const spied: LedgerTx = {
          $queryRaw: (q, ...values) => {
            ops.push(`raw:${q.raw.join('$')}|${values.join(',')}`);
            return tx.$queryRaw(q, ...values);
          },
          wallet: {
            findUnique: rec('wallet.findUnique', tx.wallet.findUnique),
            update: rec('wallet.update', tx.wallet.update),
          },
          walletEntry: {
            findUnique: rec('walletEntry.findUnique', tx.walletEntry.findUnique),
            create: rec('walletEntry.create', tx.walletEntry.create),
            count: rec('walletEntry.count', tx.walletEntry.count),
            aggregate: rec('walletEntry.aggregate', tx.walletEntry.aggregate),
          },
        };
        return fn(spied);
      });
    return perTx;
  }

  const LOCK_FIRST = /^raw:SELECT "id" FROM "Wallet" WHERE "id" = \$ FOR UPDATE\|(\S+)$/;

  it('cada $transaction de recordShipment / refund / invariante arranca con SELECT … FOR UPDATE sobre "Wallet"', async () => {
    const perTx = spyTransactions(db);
    await ship('t-aura', 'G-1');
    await ship('t-aura', 'G-1'); // no-op, pero igual bajo lock
    await ship('t-aura-2', 'G-2');
    await recordRefundForShipment(db, { tenantId: 't-aura', dacGuia: 'G-1' });
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    await assertWalletInvariant(db, w.id, YM_SEP);

    expect(perTx).toHaveLength(5);
    for (const ops of perTx) {
      expect(ops.length).toBeGreaterThan(1);
      const m = LOCK_FIRST.exec(ops[0]);
      expect(m, `primera sentencia: ${ops[0]}`).not.toBeNull();
      expect(m![1]).toBe(w.id); // el lock es sobre ESTE wallet, no sobre cualquiera
      // y ninguna lectura del período viene antes del lock
      expect(ops.slice(1).some((o) => o.startsWith('raw:'))).toBe(false);
    }
  });

  it('el espía discrimina: una transacción que lee antes de lockear no pasa', async () => {
    const perTx = spyTransactions(db);
    await db.$transaction(async (tx) => {
      await tx.walletEntry.findUnique({ where: { idemKey: 'x' } });
      await tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "id" = ${'w'} FOR UPDATE`;
    });
    expect(LOCK_FIRST.test(perTx[0][0])).toBe(false);
  });
});

describe('ledger — reparación Label → ledger (repairUnrecordedShipments)', () => {
  it('una guía persistida sin asiento se repara; correrlo dos veces no duplica', async () => {
    // El hook corrió para G-2 pero no para G-1 (SIGTERM entre el upsert y el hook).
    db.seedLabel({ id: 'l-1', tenantId: 't-aura', dacGuia: 'G-1', createdAt: AUG });
    db.seedLabel({ id: 'l-2', tenantId: 't-aura', dacGuia: 'G-2', createdAt: SEP });
    db.seedLabel({ id: 'l-p', tenantId: 't-aura', dacGuia: 'PENDING-1', createdAt: SEP });
    db.seedLabel({ id: 'l-t', tenantId: 't-aura', dacGuia: 'TEST-1', createdAt: SEP });
    db.seedLabel({ id: 'l-lf', tenantId: 't-aura', dacGuia: 'LF-000001', createdAt: SEP });
    db.seedLabel({ id: 'l-null', tenantId: 't-aura', dacGuia: null, createdAt: SEP });
    db.seedLabel({ id: 'l-o', tenantId: 't-otro', dacGuia: 'G-1', createdAt: SEP }); // misma numeración, otro user
    await ship('t-aura', 'G-2');
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    const txBefore = db.transactionsRun;

    const first = await repairUnrecordedShipments(db, { limit: 10 });
    expect(first).toMatchObject({ scanned: 6, repaired: 2, alreadyRecorded: 1, notBillable: 3, exhausted: true });
    expect(first.repairedLabelIds).toEqual(['l-1', 'l-o']);
    // una transacción por guía reparada, ninguna por las que ya estaban
    expect(db.transactionsRun - txBefore).toBe(2);

    // el período es el del hecho (createdAt), no el de hoy
    const g1 = db.entries.find((e) => e.idemKey === shipmentIdemKey('t-aura', 'G-1'));
    expect(g1).toMatchObject({ periodYm: YM_AUG, labelId: 'l-1', jobId: null, shadow: true });
    expect(db.netOf(w.id, YM_AUG)).toBe(-periodTotalMilli(1));
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(1));
    await assertWalletInvariant(db, w.id, YM_AUG);
    await assertWalletInvariant(db, w.id, YM_SEP);

    const entriesAfterFirst = db.entries.length;
    const second = await repairUnrecordedShipments(db, { limit: 10 });
    expect(second).toMatchObject({ scanned: 6, repaired: 0, alreadyRecorded: 3, notBillable: 3, exhausted: true });
    expect(db.entries).toHaveLength(entriesAfterFirst);
    expect(db.entriesOf(w.id, 'shipment')).toHaveLength(2);
  });

  it('respeta limit y pagina por cursor; el resto queda para la próxima corrida', async () => {
    for (let i = 1; i <= 7; i++) {
      db.seedLabel({ id: `l-${i}`, tenantId: 't-aura', dacGuia: `G-${i}`, createdAt: new Date(SEP.getTime() + i * 1000) });
    }
    const a = await repairUnrecordedShipments(db, { limit: 3, pageSize: 2 });
    expect(a).toMatchObject({ repaired: 3, exhausted: false });
    expect(a.repairedLabelIds).toEqual(['l-1', 'l-2', 'l-3']); // en orden de createdAt
    const b = await repairUnrecordedShipments(db, { limit: 10, pageSize: 2 });
    expect(b).toMatchObject({ repaired: 4, alreadyRecorded: 3, exhausted: true });
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    expect(db.entriesOf(w.id, 'shipment')).toHaveLength(7);
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(7));
    await assertWalletInvariant(db, w.id, YM_SEP);
  });

  it('acota por tenantId y since', async () => {
    db.seedLabel({ id: 'l-a', tenantId: 't-aura', dacGuia: 'G-A', createdAt: AUG });
    db.seedLabel({ id: 'l-s', tenantId: 't-aura', dacGuia: 'G-S', createdAt: SEP });
    db.seedLabel({ id: 'l-o', tenantId: 't-otro', dacGuia: 'G-O', createdAt: SEP });
    const r = await repairUnrecordedShipments(db, { tenantId: 't-aura', since: SEP });
    expect(r).toMatchObject({ scanned: 1, repaired: 1 });
    expect(r.repairedLabelIds).toEqual(['l-s']);
    await expect(repairUnrecordedShipments(db, { limit: 0 })).rejects.toThrow(RangeError);
  });
});

describe('ledger — modo sombra vs autoritativo', () => {
  it('modo sombra no toca balanceMilli y marca shadow=true', async () => {
    for (let i = 1; i <= 10; i++) await ship('t-aura', `G-${i}`);
    await recordRefundForShipment(db, { tenantId: 't-aura', dacGuia: 'G-3' });
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    expect(w.balanceMilli).toBe(0n);
    expect(db.entries.every((e) => e.shadow)).toBe(true);
    expect(db.netOf(w.id, YM_SEP)).toBe(-periodTotalMilli(9)); // el libro sí lleva la cuenta
  });

  it('wallet autoritativo: el saldo baja exactamente -periodTotal(n) y shadow=false', async () => {
    const w0 = await getOrCreateWalletForTenant(db, 't-aura');
    db.setAuthoritative(w0.id, true);
    for (let i = 1; i <= 55; i++) await ship('t-aura', `G-${i}`);
    const w = await getOrCreateWalletForTenant(db, 't-aura');
    expect(w.balanceMilli).toBe(-periodTotalMilli(55));
    expect(db.entries.every((e) => !e.shadow)).toBe(true);
    await recordRefundForShipment(db, { tenantId: 't-aura', dacGuia: 'G-1' });
    const w2 = await getOrCreateWalletForTenant(db, 't-aura');
    expect(w2.balanceMilli).toBe(-periodTotalMilli(54));
  });
});

describe('ledger — guías no facturables', () => {
  it('PENDING-/TEST-/LF-/vacías no se registran', async () => {
    for (const g of ['PENDING-abc', 'TEST-1', 'LF-000123', '', '   ', null, undefined]) {
      expect(isBillableGuia(g)).toBe(false);
    }
    expect(isBillableGuia(' 123456 ')).toBe(true);
    for (const g of ['PENDING-abc', 'TEST-1', 'LF-000123', '']) {
      const r = await recordShipment(db, { tenantId: 't-aura', dacGuia: g });
      expect(r).toMatchObject({ recorded: false, reason: 'not_billable' });
    }
    expect(db.entries).toHaveLength(0);
    expect(db.wallets).toHaveLength(0); // ni siquiera crea el wallet
  });

  it('tenant inexistente lanza (el hook lo atrapa; acá se ve el error)', async () => {
    await expect(ship('t-fantasma', 'G-1')).rejects.toThrow('no existe');
  });
});
