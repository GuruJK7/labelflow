'use client';

import { useMemo, useState } from 'react';
import { Calculator, TrendingDown, ArrowRight, Info, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  VOLUME_PRESETS,
  MAX_MONTHLY_SHIPMENTS,
  quoteForVolume,
  listPricingSteps,
  type VolumeQuote,
} from '@/lib/credit-packs';
import { formatUsdMilli } from '@/lib/pricing';

/**
 * Selector "¿Cuántos envíos hacés por mes?" (D34, reexpresado en dólares por D35).
 *
 * El usuario dice un número; se le muestra el escalón en el que cae, el precio
 * por envío en dólares, el total del mes, el pack que le conviene comprar y
 * cuánto le falta para el escalón siguiente. Todo sale de `lib/pricing.ts` vía
 * `lib/credit-packs.ts`: acá no se calcula nada con floats ni se inventa un precio.
 *
 * EL TIPO DE CAMBIO LLEGA POR PROP, no de `process.env`: `USD_UYU_RATE` es una
 * env de servidor y este componente corre en el navegador. Sin la prop se
 * mostrarían pesos calculados al tipo base, distintos de los que cobra el
 * checkout.
 *
 * Los dos botones de pago los maneja la página: MercadoPago cobra en pesos al
 * tipo de cambio de referencia (`USD_UYU_RATE`, no la cotización del día);
 * Whop cobra en dólares.
 */
export interface VolumeSelectorProps {
  /** Tipo de cambio en milésimos de UYU por USD, tal como lo devuelve /api/credit-packs/me. */
  usdUyuRateMilli: number;
  /** El mismo tipo, ya formateado para mostrar ("40", "41,5"). */
  usdUyuRateLabel: string;
  /**
   * Si `pack_2500`/`pack_5000` se venden en autoservicio (`ENABLE_LARGE_CREDIT_PACKS`).
   * Viene del server por `/api/credit-packs/me`: acá `process.env` está vacío.
   */
  largePacks: boolean;
  whopPacks: string[];
  loadingPackId: string | null;
  onPayMercadoPago: (packId: string) => void;
  onPayWhop: (packId: string) => void;
}

const fmt = (n: number) => n.toLocaleString('es-UY');
const usd = (milli: number) => formatUsdMilli(BigInt(Math.round(milli)));

export function VolumeSelector({
  usdUyuRateMilli,
  usdUyuRateLabel,
  largePacks,
  whopPacks,
  loadingPackId,
  onPayMercadoPago,
  onPayWhop,
}: VolumeSelectorProps) {
  const [volume, setVolume] = useState<number>(100);
  const [custom, setCustom] = useState<string>('');
  const [customError, setCustomError] = useState<string | null>(null);

  const rateMilli = BigInt(usdUyuRateMilli);
  const quote: VolumeQuote = useMemo(
    () => quoteForVolume(volume, rateMilli, { largePacks }),
    [volume, usdUyuRateMilli, largePacks],
  );
  const steps = useMemo(() => listPricingSteps(rateMilli), [usdUyuRateMilli]);
  const isPreset = (VOLUME_PRESETS as readonly number[]).includes(volume) && custom === '';
  const whopAvailable = whopPacks.includes(quote.pack.id);
  const busy = loadingPackId === quote.pack.id;
  const currentStep = quote.tierLabel;

  function applyCustom(raw: string) {
    setCustom(raw);
    if (raw.trim() === '') {
      setCustomError(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MONTHLY_SHIPMENTS) {
      setCustomError(`Ingresá un número entero entre 1 y ${fmt(MAX_MONTHLY_SHIPMENTS)}.`);
      return;
    }
    setCustomError(null);
    setVolume(n);
  }

  function pickPreset(n: number) {
    setCustom('');
    setCustomError(null);
    setVolume(n);
  }

  return (
    <section
      id="volumen"
      aria-labelledby="volumen-titulo"
      className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-zinc-900/50 backdrop-blur-xl p-6 md:p-8 mb-10"
    >
      <div className="absolute -top-32 -left-24 w-72 h-72 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="relative">
        <div className="flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-widest mb-3">
          <Calculator className="w-3.5 h-3.5" />
          Calculá tu precio
        </div>
        <h2 id="volumen-titulo" className="text-2xl md:text-3xl font-bold text-white tracking-tight">
          ¿Cuántos envíos hacés por mes?
        </h2>
        <p className="text-zinc-400 text-sm mt-2 max-w-2xl">
          Elegí un número aproximado. Te mostramos en qué escalón caés, cuánto pagás por cada envío
          y cuánto te falta para el escalón siguiente.
        </p>

        {/* Presets + campo libre */}
        <div className="flex flex-wrap items-center gap-2 mt-6">
          {VOLUME_PRESETS.map((n) => {
            const active = isPreset && volume === n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => pickPreset(n)}
                aria-pressed={active}
                className={cn(
                  'px-4 py-2 rounded-xl text-sm font-semibold tabular-nums border transition-colors',
                  active
                    ? 'bg-cyan-500 text-zinc-950 border-cyan-400 shadow-lg shadow-cyan-500/30'
                    : 'bg-white/[0.03] text-zinc-300 border-white/[0.08] hover:border-cyan-500/40 hover:text-white',
                )}
              >
                {fmt(n)}
              </button>
            );
          })}
          <label className="flex items-center gap-2 ml-1">
            <span className="text-xs text-zinc-500">Otro:</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_MONTHLY_SHIPMENTS}
              step={1}
              value={custom}
              onChange={(e) => applyCustom(e.target.value)}
              placeholder="ej. 80"
              aria-label="Otra cantidad de envíos por mes"
              className={cn(
                'w-28 px-3 py-2 rounded-xl bg-zinc-950/60 border text-sm text-white tabular-nums placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40',
                customError ? 'border-red-500/50' : custom ? 'border-cyan-500/50' : 'border-white/[0.08]',
              )}
            />
          </label>
        </div>
        {customError && <p className="text-xs text-red-400 mt-2">{customError}</p>}

        {/* Resultado */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 mt-8">
          <div className="rounded-2xl border border-cyan-500/20 bg-zinc-950/60 p-5 md:p-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  Precio por envío
                </p>
                <p className="text-3xl font-bold text-white tabular-nums">
                  USD {usd(quote.effectiveUnitUsdMilli)}
                </p>
                <p className="text-xs text-cyan-400/90 mt-1">{currentStep}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                  Tu mes con {fmt(quote.monthlyShipments)} envíos
                </p>
                <p className="text-3xl font-bold text-white tabular-nums">
                  USD {usd(quote.monthlyTotalUsdMilli)}
                </p>
                <p className="text-xs text-zinc-500 mt-1 tabular-nums">
                  ≈ ${fmt(quote.monthlyTotalUyu)} UYU
                </p>
              </div>
            </div>

            {quote.cappedByBetterTier && (
              <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2.5 py-1">
                <Check className="w-3 h-3" />
                Ya estás pagando el precio del escalón de arriba: nunca se cobra más que su total.
              </p>
            )}

            {quote.savingsVsBaseUsdMilli > 0 && (
              <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2.5 py-1">
                <TrendingDown className="w-3 h-3" />
                Ahorrás USD {usd(quote.savingsVsBaseUsdMilli)} por mes frente al precio de entrada
              </p>
            )}

            {/* El empujón al escalón siguiente. Si el ahorro real es 0 no se
                muestra: en la zona de tope el cliente ya paga ese precio, y un
                cartel diciendo "ahorrás" ahí sería mentira. */}
            {quote.nextStep && quote.nextStep.savesPerShipmentUsdMilli > 0 && (
              <div className="mt-5 flex items-start gap-2 text-xs text-zinc-400 border-t border-white/[0.06] pt-4">
                <Info className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0 mt-0.5" />
                <p>
                  Con{' '}
                  <span className="text-white font-semibold tabular-nums">
                    {fmt(quote.nextStep.shipmentsMore)}{' '}
                    {quote.nextStep.shipmentsMore === 1 ? 'envío más' : 'envíos más'}
                  </span>{' '}
                  pagás{' '}
                  <span className="text-white font-semibold tabular-nums">
                    USD {usd(quote.nextStep.savesPerShipmentUsdMilli)} menos por envío
                  </span>
                  : {quote.nextStep.label.toLowerCase()}, USD{' '}
                  {usd(quote.nextStep.unitPriceUsdMilli)} cada uno.{' '}
                  <button
                    type="button"
                    onClick={() => pickPreset(quote.nextStep!.minShipments)}
                    className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                  >
                    Ver ese escalón
                  </button>
                </p>
              </div>
            )}

            {/* Qué se compra realmente */}
            <div className="mt-5 border-t border-white/[0.06] pt-4 text-xs text-zinc-400">
              <p>
                Se compra por paquete:{' '}
                <span className="text-white font-semibold">
                  {fmt(quote.pack.shipments)} envíos
                  {quote.quantity > 1 ? ` × ${quote.quantity}` : ''}
                </span>{' '}
                por{' '}
                <span className="text-white font-semibold tabular-nums">
                  USD {usd(quote.totalPriceUsdMilli)}
                </span>{' '}
                <span className="tabular-nums">(${fmt(quote.totalPriceUyu)} UYU)</span>
                {quote.pack.shipments * quote.quantity !== quote.monthlyShipments && (
                  <span className="text-zinc-500">
                    {' '}
                    — es el más chico que te cubre; lo que sobra queda para el mes siguiente
                  </span>
                )}
                .
              </p>
              {quote.needsCustomQuote && (
                <p className="mt-2 text-amber-300/90">
                  Para {fmt(quote.monthlyShipments)} envíos por mes el precio se arma a medida:
                  escribinos por WhatsApp y lo cerramos. Comprando paquetes sueltos te saldría más
                  caro que el precio de tu escalón — mientras tanto podés repetir la compra{' '}
                  {quote.quantity} veces.
                </p>
              )}
            </div>
          </div>

          {/* Botones de pago */}
          <div className="flex flex-col gap-3 lg:w-64 lg:justify-center">
            <button
              type="button"
              onClick={() => onPayMercadoPago(quote.pack.id)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-zinc-950 text-sm font-semibold transition-all shadow-lg shadow-cyan-500/30 disabled:opacity-50 disabled:cursor-wait"
            >
              {busy ? 'Redirigiendo...' : 'Pagar con MercadoPago'}
              {!busy && <ArrowRight className="w-4 h-4" />}
            </button>
            {whopAvailable && (
              <button
                type="button"
                onClick={() => onPayWhop(quote.pack.id)}
                disabled={busy}
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-white text-sm font-semibold border border-white/[0.1] hover:border-cyan-500/30 transition-all disabled:opacity-50 disabled:cursor-wait"
              >
                Pagar con Whop
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
            <p className="text-[11px] text-zinc-500 leading-snug">
              Los precios están en dólares. MercadoPago los cobra en pesos al tipo de cambio de
              referencia que usamos ({usdUyuRateLabel} UYU/USD, lo actualizamos cada tanto; no es la
              cotización del día)
              {whopAvailable ? '; Whop cobra en dólares con tarjeta internacional' : ''}.
            </p>
          </div>
        </div>

        {/* La escalera completa */}
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-white mb-3">La escalera completa</h3>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm min-w-[520px]">
              <caption className="sr-only">
                Precio por envío en dólares según los envíos que hagas en el mes
              </caption>
              <thead>
                <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                  <th scope="col" className="text-left pb-2 px-2 font-medium">
                    Envíos por mes
                  </th>
                  <th scope="col" className="text-right pb-2 px-2 font-medium">
                    Por envío
                  </th>
                  <th scope="col" className="text-right pb-2 px-2 font-medium">
                    Mes completo
                  </th>
                  <th scope="col" className="text-right pb-2 px-2 font-medium">
                    En pesos
                  </th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {steps.map((step, i) => {
                  const active = step.label === currentStep;
                  const next = steps[i + 1];
                  const range = next
                    ? `${fmt(Math.max(step.minShipments, 1))} – ${fmt(next.minShipments - 1)}`
                    : `${fmt(step.minShipments)} o más`;
                  return (
                    <tr
                      key={step.minShipments}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'border-t border-white/[0.04]',
                        active ? 'bg-cyan-500/[0.08] text-white' : 'hover:bg-white/[0.02]',
                      )}
                    >
                      <td className="py-2.5 px-2 tabular-nums">
                        {range}
                        {active && (
                          <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-cyan-400">
                            Tu escalón
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-semibold">
                        USD {usd(step.unitPriceUsdMilli)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums">
                        USD {usd(step.totalAtStepUsdMilli)}
                      </td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-zinc-500">
                        ${fmt(step.totalAtStepUyu)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500 mt-3">
            &quot;Mes completo&quot; es lo que cuesta el mes al entrar en el escalón. Nunca se cobra
            más que el total del escalón siguiente: hacer un envío más jamás te sube la factura.
          </p>
        </div>

        <p className="text-xs text-zinc-500 mt-6">
          Los envíos no vencen y se comparten entre todas tus tiendas. Cada guía creada en DAC
          descuenta un envío. Los montos en pesos salen del tipo de cambio de referencia que usamos
          ({usdUyuRateLabel} UYU/USD) y pueden cambiar.
        </p>
      </div>
    </section>
  );
}
