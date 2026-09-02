import { describe, it, expect } from 'vitest';
import { PRICING_TIERS, periodTotalUsdMilli, BASE_USD_UYU_RATE_MILLI } from '@/lib/pricing';
import {
  TIERS as WORKER_TIERS,
  periodTotalMilli as workerPeriodTotalMilli,
  usdMilliToUyuMilliAtBase,
  BASE_USD_UYU_RATE_MILLI as WORKER_BASE_RATE,
} from '../../../worker/src/billing/tiers';

/**
 * EL TEST QUE FALLA SI LAS DOS ESCALERAS DIVERGEN.
 *
 * `apps/web/lib/pricing.ts` (lo que se cobra) y
 * `apps/worker/src/billing/tiers.ts` (lo que se liquida en el ledger) tienen
 * la misma escalera DUPLICADA: son apps separadas y el worker compila a
 * CommonJS con `rootDir: "./src"`, así que no puede importar fuera de su
 * árbol. Un `import` relativo desde acá sí funciona porque Vitest transforma
 * TypeScript en memoria y no le importa el `rootDir` del worker.
 *
 * Si alguien cambia un precio en un solo lado, la web cobra una cosa y el
 * ledger factura otra, y la diferencia sale de la caja de Adrian sin que nadie
 * emita un error. Este archivo es la única cosa que lo impide.
 */
describe('la escalera de la web y la del worker son la MISMA', () => {
  it('mismo tipo de cambio base', () => {
    expect(WORKER_BASE_RATE).toBe(BASE_USD_UYU_RATE_MILLI);
  });

  it('misma cantidad de escalones', () => {
    expect(WORKER_TIERS).toHaveLength(PRICING_TIERS.length);
  });

  it('mismos cortes y mismos precios en dólares, escalón por escalón', () => {
    const web = PRICING_TIERS.map((t) => [t.minShipments, Number(t.unitPriceUsdMilli)]);
    const worker = WORKER_TIERS.map((t) => [t.minShipments, Number(t.unitPriceUsdMilli)]);
    expect(worker).toEqual(web);
  });

  it('el precio en pesos del worker sale del de dólares al tipo base', () => {
    for (const t of WORKER_TIERS) {
      expect(t.unitPriceMilli, `escalón ${t.minShipments}`).toBe(
        usdMilliToUyuMilliAtBase(t.unitPriceUsdMilli),
      );
    }
  });

  it('los dos totales del período coinciden envío por envío, de 0 a 6000', () => {
    // No alcanza con comparar las tablas: las dos implementaciones de
    // `periodTotal` tienen que dar lo mismo. Si una pierde el `min` que la hace
    // monótona, esto lo agarra.
    for (let n = 0; n <= 6000; n++) {
      const web = periodTotalUsdMilli(n);
      const worker = workerPeriodTotalMilli(n);
      // El worker está en milésimos de UYU al tipo base; la web en milésimos
      // de USD. Se comparan llevando la web a pesos con la misma función.
      expect(worker, `n=${n}`).toBe(usdMilliToUyuMilliAtBase(web));
    }
  });
});
