import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordShipment,
  recordRefundForShipment,
  assertWalletInvariant,
  getOrCreateWalletForTenant,
  isBillableGuia,
} from '../billing/ledger';
import { periodTotalMilli, uyu } from '../billing/tiers';
import { periodOf } from '../billing/settle';
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
    expect(db.netOf(w.id, YM_SEP)).toBe(-uyu(850)); // 49×20=980 > 50×17=850 → techo
    await ship('t-aura', 'G-50');
    expect(db.netOf(w.id, YM_SEP)).toBe(-uyu(850));
    await ship('t-aura', 'G-51');
    expect(db.netOf(w.id, YM_SEP)).toBe(-uyu(51 * 17));
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
