import { describe, it, expect } from 'vitest';
import { checkRunGate, checkPlanLimit, creditBalance } from '../can-run';

/**
 * Tabla de estados del disparo manual.
 *
 * Este archivo existe porque la revisión adversarial del 2026-09-01 encontró que
 * el cambio de gate viajaba sin un solo test, y que además era INERTE para su
 * población objetivo: destrabábamos `checkRunGate` y el cliente moría 14 líneas
 * más abajo en el tope de plan con un 429 "límite de 0 etiquetas".
 *
 * Lo que se congela acá es la enumeración completa, para que el gate no pueda
 * volver a divergir del scheduler del worker sin que algo falle.
 */

const holder = (o: Partial<Parameters<typeof checkRunGate>[0]> = {}) => ({
  isActive: true,
  subscriptionStatus: 'INACTIVE',
  shipmentCredits: 10,
  referralBonusCredits: 0,
  ...o,
});

const SUB_STATES = ['INACTIVE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED'];

describe('checkRunGate', () => {
  it('la cuenta pausada se bloquea siempre, tenga el saldo que tenga', () => {
    for (const s of SUB_STATES) {
      for (const cred of [0, 10, 1000]) {
        const r = checkRunGate(holder({ isActive: false, subscriptionStatus: s, shipmentCredits: cred }));
        expect(r.ok, `isActive=false sub=${s} cred=${cred}`).toBe(false);
        if (!r.ok) expect(r.status).toBe(403);
      }
    }
  });

  it('EL CASO QUE MOTIVÓ EL FIX: cliente de packs, activo y con saldo, puede disparar', () => {
    const r = checkRunGate(holder({ subscriptionStatus: 'INACTIVE', shipmentCredits: 40 }));
    expect(r.ok).toBe(true);
  });

  it('sin saldo y sin suscripción legacy, se bloquea con un mensaje sobre el saldo', () => {
    const r = checkRunGate(holder({ shipmentCredits: 0, referralBonusCredits: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/sin envíos/i);
  });

  it('el legacy con suscripción viva pasa aunque tenga saldo en 0 — no se rompe a nadie', () => {
    const r = checkRunGate(holder({ subscriptionStatus: 'ACTIVE', shipmentCredits: 0 }));
    expect(r.ok).toBe(true);
  });

  it('el saldo bonificado cuenta igual que el comprado', () => {
    expect(checkRunGate(holder({ shipmentCredits: 0, referralBonusCredits: 5 })).ok).toBe(true);
    expect(creditBalance({ shipmentCredits: 3, referralBonusCredits: 4 })).toBe(7);
  });

  it('NO ES REGRESIÓN: todo lo que pasaba antes, sigue pasando', () => {
    // El gate viejo era `isActive && subscriptionStatus === 'ACTIVE'`.
    // Barrido completo: nada que antes pasara puede fallar ahora.
    for (const isActive of [true, false]) {
      for (const s of SUB_STATES) {
        for (const cred of [0, 1, 100]) {
          const pasabaAntes = isActive && s === 'ACTIVE';
          const pasaAhora = checkRunGate(
            holder({ isActive, subscriptionStatus: s, shipmentCredits: cred }),
          ).ok;
          if (pasabaAntes) {
            expect(pasaAhora, `regresión en isActive=${isActive} sub=${s} cred=${cred}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('checkPlanLimit', () => {
  // El de verdad: devuelve 0 cuando no hay plan. Ese 0 era el bug.
  const getLimit = (planId: string | null) => (planId === 'plan_pro' ? 500 : 0);

  it('EL BUG QUE ENCONTRÓ LA REVISIÓN: sin plan legacy no se aplica tope de etiquetas', () => {
    // Antes: getPlanLimit(null) = 0, y `0 >= 0` daba 429 "límite de 0 etiquetas".
    const r = checkPlanLimit({ stripePriceId: null, labelsThisMonth: 0 }, getLimit);
    expect(r.ok).toBe(true);
  });

  it('sin plan legacy tampoco topea con etiquetas ya emitidas este mes', () => {
    expect(checkPlanLimit({ stripePriceId: null, labelsThisMonth: 9999 }, getLimit).ok).toBe(true);
  });

  it('con plan legacy sigue topeando exactamente como antes', () => {
    expect(checkPlanLimit({ stripePriceId: 'plan_pro', labelsThisMonth: 499 }, getLimit).ok).toBe(true);
    const r = checkPlanLimit({ stripePriceId: 'plan_pro', labelsThisMonth: 500 }, getLimit);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(429);
      expect(r.message).toContain('500');
    }
  });

  it('un plan legacy desconocido topea en 0, que es el comportamiento previo', () => {
    const r = checkPlanLimit({ stripePriceId: 'plan_borrado', labelsThisMonth: 0 }, getLimit);
    expect(r.ok).toBe(false);
  });
});

describe('el gate completo, encadenado como en las rutas', () => {
  const getLimit = (planId: string | null) => (planId === 'plan_pro' ? 500 : 0);

  function puedeDisparar(t: {
    isActive: boolean; subscriptionStatus: string; shipmentCredits: number;
    referralBonusCredits: number; stripePriceId: string | null; labelsThisMonth: number;
  }): boolean {
    const a = checkRunGate(t);
    if (!a.ok) return false;
    return checkPlanLimit(t, getLimit).ok;
  }

  it('el cliente de packs con saldo llega hasta el final de la cadena', () => {
    expect(puedeDisparar({
      isActive: true, subscriptionStatus: 'INACTIVE', shipmentCredits: 40,
      referralBonusCredits: 0, stripePriceId: null, labelsThisMonth: 320,
    })).toBe(true);
  });

  it('el legacy que agotó su plan sigue frenado', () => {
    expect(puedeDisparar({
      isActive: true, subscriptionStatus: 'ACTIVE', shipmentCredits: 0,
      referralBonusCredits: 0, stripePriceId: 'plan_pro', labelsThisMonth: 500,
    })).toBe(false);
  });

  it('la cuenta pausada no llega ni al tope de plan', () => {
    expect(puedeDisparar({
      isActive: false, subscriptionStatus: 'ACTIVE', shipmentCredits: 999,
      referralBonusCredits: 0, stripePriceId: 'plan_pro', labelsThisMonth: 0,
    })).toBe(false);
  });
});
