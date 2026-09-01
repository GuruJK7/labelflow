import { describe, it, expect } from 'vitest';
import {
  computeSettlement,
  assertPeriodInvariant,
  shipmentIdemKey,
  settlementIdemKey,
  periodOf,
} from '../billing/settle';
import { periodTotalMilli, uyu, unitPriceFor } from '../billing/tiers';

/**
 * Ledger append-only en memoria. Modela exactamente lo que hará la tabla real:
 * asientos inmutables, idempotencia por clave, y liquidación tras cada evento.
 */
class Ledger {
  private entries: Array<{ idemKey: string; deltaMilli: bigint; reason: string }> = [];
  private guias = new Set<string>();
  private settleSeq = 0;

  get netMilli(): bigint {
    return this.entries.reduce((a, e) => a + e.deltaMilli, 0n);
  }
  get billable(): number {
    return this.guias.size;
  }
  get entryCount(): number {
    return this.entries.length;
  }

  /** Devuelve false si la guía ya estaba facturada (choque de clave única). */
  addShipment(tenantId: string, guia: string): boolean {
    const key = shipmentIdemKey(tenantId, guia);
    if (this.entries.some((e) => e.idemKey === key)) return false;
    this.entries.push({ idemKey: key, deltaMilli: 0n, reason: 'shipment' });
    this.guias.add(key);
    this.settle();
    return true;
  }

  refundShipment(tenantId: string, guia: string): boolean {
    const key = shipmentIdemKey(tenantId, guia);
    if (!this.guias.has(key)) return false;
    this.guias.delete(key);
    this.entries.push({ idemKey: `refund:${key}`, deltaMilli: 0n, reason: 'shipment' });
    this.settle();
    return true;
  }

  private settle(): void {
    const s = computeSettlement({
      billableShipments: this.billable,
      recordedNetMilli: this.netMilli,
    });
    if (s.deltaMilli === 0n) return;
    this.entries.push({
      idemKey: settlementIdemKey('w1', '2026-09', this.settleSeq++),
      deltaMilli: s.deltaMilli,
      reason: 'settlement',
    });
  }
}

describe('liquidación — invariante del período', () => {
  it('tras cada envío el período vale exactamente lo que debe valer', () => {
    const l = new Ledger();
    for (let i = 1; i <= 1200; i++) {
      l.addShipment('t1', `G${i}`);
      expect(() => assertPeriodInvariant(l.billable, l.netMilli)).not.toThrow();
      expect(l.netMilli).toBe(-periodTotalMilli(i));
    }
  });

  it('cobrar dos veces la misma guía no cambia un peso', () => {
    const l = new Ledger();
    l.addShipment('t1', 'G1');
    const neto = l.netMilli;
    const asientos = l.entryCount;

    expect(l.addShipment('t1', 'G1')).toBe(false);
    expect(l.addShipment('t1', 'G1')).toBe(false);

    expect(l.netMilli).toBe(neto);
    expect(l.entryCount).toBe(asientos);
    expect(l.billable).toBe(1);
  });

  it('la misma guía en DOS clientes distintos se cobra a los dos', () => {
    // Cada cliente usa su propia cuenta DAC y DAC numera por cuenta: el mismo
    // número de guía puede tocarle a dos clientes. Sin el tenantId en la clave,
    // el segundo envío salía gratis, en silencio.
    const l = new Ledger();
    expect(l.addShipment('tenantA', '0012345')).toBe(true);
    expect(l.addShipment('tenantB', '0012345')).toBe(true);
    expect(l.billable).toBe(2);
    expect(l.netMilli).toBe(-periodTotalMilli(2));
  });

  it('un reintegro deja el período en el valor correcto, no en el precio bruto', () => {
    const l = new Ledger();
    for (let i = 1; i <= 300; i++) l.addShipment('t1', `G${i}`);
    expect(l.netMilli).toBe(-periodTotalMilli(300));

    for (let i = 1; i <= 60; i++) l.refundShipment('t1', `G${i}`);
    expect(l.billable).toBe(240);
    expect(l.netMilli).toBe(-periodTotalMilli(240));
  });

  it('reintegrar algo que no se facturó no hace nada', () => {
    const l = new Ledger();
    l.addShipment('t1', 'G1');
    const neto = l.netMilli;
    expect(l.refundShipment('t1', 'NO-EXISTE')).toBe(false);
    expect(l.netMilli).toBe(neto);
  });

  it('la liquidación es auto-reparable: corrige un asiento perdido', () => {
    // Si por un crash quedó registrado de menos, la siguiente liquidación
    // lleva el período a su valor correcto sin intervención.
    const roto = computeSettlement({ billableShipments: 100, recordedNetMilli: -uyu(400) });
    expect(roto.deltaMilli).toBe(-uyu(1100));
    expect(-uyu(400) + roto.deltaMilli).toBe(-periodTotalMilli(100));

    // Y si quedó registrado de MÁS, la corrección va en sentido contrario.
    const pasado = computeSettlement({ billableShipments: 100, recordedNetMilli: -uyu(9000) });
    expect(pasado.deltaMilli).toBe(uyu(7500));
    expect(-uyu(9000) + pasado.deltaMilli).toBe(-periodTotalMilli(100));
  });

  it('liquidar dos veces seguidas sin eventos nuevos no emite nada', () => {
    const estado = { billableShipments: 250, recordedNetMilli: -periodTotalMilli(250) };
    expect(computeSettlement(estado).deltaMilli).toBe(0n);
  });

  it('se planta si el neto del período es positivo en vez de tapar el problema', () => {
    expect(() =>
      computeSettlement({ billableShipments: 10, recordedNetMilli: uyu(5) }),
    ).toThrow(/mal clasificados/);
  });
});

describe('liquidación — el arbitraje que rompió la spec anterior', () => {
  it('MIL ENVÍOS Y REINTEGRO TOTAL NO CREAN SALDO', () => {
    // El ataque exacto que encontró la revisión adversarial del 2026-09-01
    // contra el diseño de rebates: con débito bruto + reintegro al precio de
    // lista, un depósito de 7.000 terminaba en 12.087 de saldo acreditado.
    const DEPOSITO = uyu(7000);
    const l = new Ledger();

    for (let i = 1; i <= 1000; i++) l.addShipment('t1', `G${i}`);
    expect(l.netMilli).toBe(-uyu(7000));
    expect(DEPOSITO + l.netMilli).toBe(0n); // gastó todo, saldo cero

    for (let i = 1; i <= 1000; i++) l.refundShipment('t1', `G${i}`);

    expect(l.billable).toBe(0);
    expect(l.netMilli).toBe(0n);
    const saldoFinal = DEPOSITO + l.netMilli;
    expect(saldoFinal).toBe(DEPOSITO); // exactamente lo depositado, ni un peso más
    expect(saldoFinal).toBeLessThan(uyu(12087)); // el número del ataque, ahora imposible
  });

  it('reintegrar sólo los envíos caros tampoco deja ganancia', () => {
    // La variante suave del ataque: quedarse con los baratos y devolver los
    // caros, que en el modelo de rebates dejaba el envío a 3,89 en vez de 7.
    const DEPOSITO = uyu(7000);
    const l = new Ledger();
    for (let i = 1; i <= 1000; i++) l.addShipment('t1', `G${i}`);
    for (let i = 1; i <= 249; i++) l.refundShipment('t1', `G${i}`);

    const quedaron = 751;
    expect(l.billable).toBe(quedaron);
    expect(l.netMilli).toBe(-periodTotalMilli(quedaron));

    const pagadoNeto = -l.netMilli;
    const efectivo = pagadoNeto / BigInt(quedaron);
    // Con 751 envíos el techo es el total del tramo de 1000: 7.000.
    expect(pagadoNeto).toBe(uyu(7000));
    // El piso del tarifario es 7 UYU/envío. El precio efectivo nunca puede
    // quedar por debajo: eso era exactamente lo que lograba el ataque (3,89).
    expect(efectivo).toBeGreaterThanOrEqual(unitPriceFor(1000));
    expect(DEPOSITO + l.netMilli).toBe(0n);
  });

  it('ningún orden de eventos deja saldo por encima de lo depositado', () => {
    // Barrido determinístico sobre muchas mezclas de altas y bajas.
    const DEPOSITO = uyu(50_000);
    for (let semilla = 1; semilla <= 40; semilla++) {
      const l = new Ledger();
      const vivas: string[] = [];
      let x = semilla;
      const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;

      for (let paso = 0; paso < 600; paso++) {
        if (vivas.length > 0 && rnd() < 0.3) {
          const i = Math.floor(rnd() * vivas.length);
          l.refundShipment('t1', vivas[i]);
          vivas.splice(i, 1);
        } else {
          const g = `G${paso}`;
          if (l.addShipment('t1', g)) vivas.push(g);
        }
        expect(() => assertPeriodInvariant(l.billable, l.netMilli)).not.toThrow();
      }
      const saldo = DEPOSITO + l.netMilli;
      expect(saldo, `semilla ${semilla}`).toBeLessThanOrEqual(DEPOSITO);
    }
  });
});

describe('claves de idempotencia', () => {
  it('la clave lleva el cliente adentro', () => {
    expect(shipmentIdemKey('t1', '999')).toBe('ship:v1:t1:999');
    expect(shipmentIdemKey('t1', '999')).not.toBe(shipmentIdemKey('t2', '999'));
  });

  it('no factura placeholders', () => {
    expect(() => shipmentIdemKey('t1', 'PENDING-1712345')).toThrow(/no es una guía real/);
    expect(() => shipmentIdemKey('t1', 'TEST-1')).toThrow(/no es una guía real/);
  });

  it('rechaza guía o cliente vacíos', () => {
    expect(() => shipmentIdemKey('', '999')).toThrow(/falta tenantId/);
    expect(() => shipmentIdemKey('t1', '   ')).toThrow(/falta la guía/);
  });

  it('ignora espacios alrededor de la guía', () => {
    expect(shipmentIdemKey('t1', '  999  ')).toBe('ship:v1:t1:999');
  });

  it('valida el formato del período', () => {
    expect(() => settlementIdemKey('w1', '2026-9', 0)).toThrow(/Período inválido/);
    expect(settlementIdemKey('w1', '2026-09', 3)).toBe('settle:v1:w1:2026-09:3');
  });
});

describe('período contable', () => {
  it('usa la hora de Uruguay, no UTC', () => {
    // 1 de octubre 01:30 UTC es todavía 30 de setiembre 22:30 en Montevideo:
    // ese envío tiene que facturarse en setiembre.
    expect(periodOf(new Date('2026-10-01T01:30:00Z'))).toBe('2026-09');
    expect(periodOf(new Date('2026-10-01T03:30:00Z'))).toBe('2026-10');
    expect(periodOf(new Date('2026-09-15T12:00:00Z'))).toBe('2026-09');
  });
});
