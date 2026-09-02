'use client';

import { useMemo, useState } from 'react';
import { Calculator, TrendingDown, ArrowRight, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  VOLUME_PRESETS,
  MAX_MONTHLY_SHIPMENTS,
  quoteForVolume,
  type VolumeQuote,
} from '@/lib/credit-packs';

/**
 * Selector "¿Cuántos envíos hacés por mes?" (D34).
 *
 * El usuario dice un número; se le muestra el pack más chico que lo cubre,
 * el precio por envío de ese pack, el total, el ahorro frente a comprar de a
 * 10 y cuánto le falta para el tramo siguiente. Los precios salen de
 * `lib/credit-packs.ts` (los mismos tramos que cobra el worker): acá no se
 * calcula nada con floats ni se inventa un precio.
 *
 * Los dos botones de pago los maneja la página: MercadoPago es el flujo de
 * packs existente; Whop aparece sólo si el pack tiene link configurado.
 */
export interface VolumeSelectorProps {
  whopPacks: string[];
  loadingPackId: string | null;
  onPayMercadoPago: (packId: string) => void;
  onPayWhop: (packId: string) => void;
}

const fmt = (n: number) => n.toLocaleString('es-UY');

export function VolumeSelector({ whopPacks, loadingPackId, onPayMercadoPago, onPayWhop }: VolumeSelectorProps) {
  const [volume, setVolume] = useState<number>(100);
  const [custom, setCustom] = useState<string>('');
  const [customError, setCustomError] = useState<string | null>(null);

  const quote: VolumeQuote = useMemo(() => quoteForVolume(volume), [volume]);
  const isPreset = (VOLUME_PRESETS as readonly number[]).includes(volume) && custom === '';
  const whopAvailable = whopPacks.includes(quote.pack.id);
  const busy = loadingPackId === quote.pack.id;

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
          Elegí un número aproximado. Te mostramos el pack que te conviene, cuánto pagás por cada
          envío y cuánto te falta para el tramo siguiente.
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
            <p className="text-sm text-zinc-300">
              Con <span className="font-semibold text-white tabular-nums">{fmt(quote.monthlyShipments)}</span>{' '}
              envíos por mes te conviene el{' '}
              <span className="font-semibold text-white">
                pack de {fmt(quote.pack.shipments)} envíos
                {quote.quantity > 1 ? ` × ${quote.quantity}` : ''}
              </span>
              {quote.pack.shipments * quote.quantity !== quote.monthlyShipments && (
                <span className="text-zinc-500">
                  {' '}
                  (es el más chico que te cubre; lo que sobra queda para el mes siguiente)
                </span>
              )}
              .
            </p>

            <div className="grid grid-cols-2 gap-4 mt-5">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Precio por envío</p>
                <p className="text-3xl font-bold text-white tabular-nums">
                  ${fmt(quote.pricePerShipmentUyu)}{' '}
                  <span className="text-sm font-medium text-zinc-500">UYU</span>
                </p>
                <p className="text-xs text-cyan-400/90 mt-1">{quote.tierLabel}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Total a pagar</p>
                <p className="text-3xl font-bold text-white tabular-nums">
                  ${fmt(quote.totalPriceUyu)}{' '}
                  <span className="text-sm font-medium text-zinc-500">UYU</span>
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  {fmt(quote.pack.shipments * quote.quantity)} envíos, pago único
                </p>
              </div>
            </div>

            {quote.savingsVsBaseUyu > 0 && (
              <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2.5 py-1">
                <TrendingDown className="w-3 h-3" />
                Ahorrás ${fmt(quote.savingsVsBaseUyu)} UYU frente a comprar de a 10
              </p>
            )}

            {quote.nextTier && (
              <div className="mt-5 flex items-start gap-2 text-xs text-zinc-400 border-t border-white/[0.06] pt-4">
                <Info className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0 mt-0.5" />
                <p>
                  Con{' '}
                  <span className="text-white font-semibold tabular-nums">
                    {fmt(quote.nextTier.shipmentsMore)} envíos más
                  </span>{' '}
                  (pack de {fmt(quote.nextTier.pack.shipments)}) pagás{' '}
                  <span className="text-white font-semibold">${fmt(quote.nextTier.pricePerShipmentUyu)} UYU</span>{' '}
                  por envío: ${fmt(quote.nextTier.totalPriceUyu)} UYU en total.{' '}
                  <button
                    type="button"
                    onClick={() => pickPreset(quote.nextTier!.pack.shipments)}
                    className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                  >
                    Ver ese pack
                  </button>
                </p>
              </div>
            )}

            {quote.quantity > 1 && (
              <div className="mt-5 flex items-start gap-2 text-xs text-amber-300/90 border-t border-white/[0.06] pt-4">
                <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <p>
                  Se compra de a un pack por vez: repetí la compra {quote.quantity} veces o escribinos
                  por WhatsApp para armar un pack a medida.
                </p>
              </div>
            )}
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
              {whopAvailable
                ? 'MercadoPago cobra en pesos uruguayos. Whop cobra con tarjeta internacional en dólares.'
                : 'Pago único en pesos uruguayos, con tarjeta o dinero en cuenta de MercadoPago.'}
            </p>
          </div>
        </div>

        <p className="text-xs text-zinc-500 mt-6">
          Los envíos no vencen y se comparten entre todas tus tiendas. Cada guía creada en DAC
          descuenta un envío.
        </p>
      </div>
    </section>
  );
}
