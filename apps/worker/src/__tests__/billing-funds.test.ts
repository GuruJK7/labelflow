import { describe, it, expect } from 'vitest';
import {
  canSpend,
  smmSpendableMilli,
  paidInDelta,
  formatMilli,
  type WalletFunds,
} from '../billing/funds';
import { uyu } from '../billing/tiers';

const wallet = (over: Partial<WalletFunds> = {}): WalletFunds => ({
  balanceMilli: uyu(1000),
  paidInMilli: uyu(1000),
  smmSpentMilli: 0n,
  ...over,
});

describe('fondos — envíos', () => {
  it('un envío siempre se asienta, incluso sin saldo', () => {
    // Cuando esto corre, DAC ya emitió la guía: el envío físico existe y es
    // irreversible. No cobrarlo no lo deshace, sólo pierde la plata.
    const f = wallet({ balanceMilli: 0n });
    expect(canSpend(f, { amountMilli: uyu(20), product: 'shipping' }).allowed).toBe(true);
  });

  it('un envío se asienta aun con saldo ya negativo', () => {
    const f = wallet({ balanceMilli: -uyu(500) });
    expect(canSpend(f, { amountMilli: uyu(20), product: 'shipping' }).allowed).toBe(true);
  });

  it('rechaza montos no positivos', () => {
    const f = wallet();
    for (const monto of [0n, -1n, -uyu(5)]) {
      const d = canSpend(f, { amountMilli: monto, product: 'shipping' });
      expect(d.allowed).toBe(false);
      if (!d.allowed) expect(d.reason).toBe('invalid_amount');
    }
  });
});

describe('fondos — AutoBoost sólo con plata real', () => {
  it('deja gastar hasta lo que efectivamente se cargó', () => {
    const f = wallet({ paidInMilli: uyu(1000), smmSpentMilli: 0n });
    expect(canSpend(f, { amountMilli: uyu(1000), product: 'smm' }).allowed).toBe(true);
  });

  it('NO deja gastar saldo de regalo en AutoBoost', () => {
    // El caso que importa: 10 envíos de bienvenida son saldo, pero AutoBoost
    // le cuesta a LabelFlow dólares reales con su proveedor mayorista.
    const f = wallet({ balanceMilli: uyu(200), paidInMilli: 0n, smmSpentMilli: 0n });
    const d = canSpend(f, { amountMilli: uyu(50), product: 'smm' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('smm_requires_cash');
  });

  it('el tope de AutoBoost es acumulado, no por operación', () => {
    const f = wallet({ paidInMilli: uyu(1000), smmSpentMilli: uyu(900) });
    expect(canSpend(f, { amountMilli: uyu(100), product: 'smm' }).allowed).toBe(true);
    expect(canSpend(f, { amountMilli: uyu(101), product: 'smm' }).allowed).toBe(false);
  });

  it('el sobrante de envíos SÍ se puede gastar en bots — es el pedido original', () => {
    // "Si compran 300 envíos y su tienda hizo 280, que usen esos 20 en bots".
    // Cargó 7.000 (mil envíos), gastó 280 a precio efectivo. El resto es plata
    // cargada y por lo tanto gastable en AutoBoost.
    const gastadoEnEnvios = uyu(4760);
    const f = wallet({
      balanceMilli: uyu(7000) - gastadoEnEnvios,
      paidInMilli: uyu(7000),
      smmSpentMilli: 0n,
    });
    expect(smmSpendableMilli(f)).toBe(uyu(2240));
    expect(canSpend(f, { amountMilli: uyu(2240), product: 'smm' }).allowed).toBe(true);
    expect(canSpend(f, { amountMilli: uyu(2241), product: 'smm' }).allowed).toBe(false);
  });

  it('no deja gastar más que el saldo aunque haya cargado mucho histórico', () => {
    const f = wallet({ balanceMilli: uyu(10), paidInMilli: uyu(9000), smmSpentMilli: 0n });
    const d = canSpend(f, { amountMilli: uyu(500), product: 'smm' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('insufficient_balance');
    expect(smmSpendableMilli(f)).toBe(uyu(10));
  });

  it('smmSpendable nunca es negativo', () => {
    const f = wallet({ balanceMilli: -uyu(50), paidInMilli: 0n, smmSpentMilli: uyu(300) });
    expect(smmSpendableMilli(f)).toBe(0n);
  });
});

describe('fondos — reembolsos y contracargos', () => {
  it('el contracargo BAJA la plata cargada', () => {
    // Sin esta simetría, un depósito seguido de contracargo deja habilitado
    // para siempre el gasto en dólares: era el hallazgo del ataque.
    expect(paidInDelta('purchase', uyu(1000))).toBe(uyu(1000));
    expect(paidInDelta('chargeback', uyu(1000))).toBe(-uyu(1000));
    expect(paidInDelta('refund', uyu(1000))).toBe(-uyu(1000));
  });

  it('el saldo de regalo no habilita gasto en dólares', () => {
    expect(paidInDelta('grant', uyu(500))).toBe(0n);
  });

  it('tras el contracargo, AutoBoost queda cerrado', () => {
    const antes = wallet({ paidInMilli: uyu(1000), smmSpentMilli: 0n });
    expect(canSpend(antes, { amountMilli: uyu(100), product: 'smm' }).allowed).toBe(true);

    const despues = wallet({
      paidInMilli: antes.paidInMilli + paidInDelta('chargeback', uyu(1000)),
      smmSpentMilli: 0n,
    });
    expect(canSpend(despues, { amountMilli: uyu(100), product: 'smm' }).allowed).toBe(false);
    expect(smmSpendableMilli(despues)).toBe(0n);
  });

  it('paidIn puede quedar negativo y eso está bien', () => {
    const f = wallet({ paidInMilli: uyu(1000), smmSpentMilli: uyu(1000) });
    const nuevo = f.paidInMilli + paidInDelta('chargeback', uyu(1000));
    expect(nuevo).toBe(0n);
    // Ya había gastado los 1.000 en AutoBoost: el negocio se comió el costo.
    // Queda registrado y visible, no clampeado a cero en silencio.
    expect(smmSpendableMilli({ ...f, paidInMilli: nuevo })).toBe(0n);
  });

  it('rechaza montos negativos en movimientos', () => {
    expect(() => paidInDelta('purchase', -1n)).toThrow(RangeError);
  });
});

describe('formato de plata', () => {
  it('muestra pesos y centavos', () => {
    expect(formatMilli(uyu(1500))).toBe('$1.500,00');
    expect(formatMilli(7000n)).toBe('$7,00');
    expect(formatMilli(7500n)).toBe('$7,50');
    expect(formatMilli(0n)).toBe('$0,00');
  });

  it('muestra el negativo adelante', () => {
    expect(formatMilli(-uyu(20))).toBe('-$20,00');
  });
});
