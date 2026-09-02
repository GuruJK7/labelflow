'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import {
  quoteForVolume,
  VOLUME_PRESETS,
  BASE_PRICE_PER_SHIPMENT_UYU,
} from '@/lib/credit-packs';

/**
 * Selector de precios de la landing.
 *
 * POR QUÉ COTIZA PACKS Y NO "PRECIO POR VOLUMEN MENSUAL"
 * -----------------------------------------------------
 * La pregunta que hace ("¿cuántos envíos hacés por mes?") es la del brief, pero
 * la respuesta NO puede ser "entonces te cobramos X por envío": hoy el cobro es
 * por pack comprado (`credit-packs/checkout` crea una Preference de pago único
 * en MercadoPago). El tarifario por volumen mensual existe en el worker
 * (`billing/tiers.ts`) con los mismos precios, pero corre en modo sombra y
 * apagado por default, así que nadie factura por ahí todavía. Prometer un
 * descuento retroactivo por volumen sería vender un modelo que no cobra así.
 *
 * Por eso el volumen es sólo la entrada: `quoteForVolume` traduce ese número al
 * pack que lo cubre y el panel muestra lo que la persona efectivamente paga.
 *
 * Toda la aritmética es del cliente y sale de `lib/credit-packs.ts` — la misma
 * tabla que cobra el checkout. No se llama a ninguna API: no hay precio que
 * pueda quedar desincronizado con lo que dice la caja.
 */

const fmt = (n: number) => n.toLocaleString('es-UY');

const MIN = 10;
const MAX = 1000;
const STEP = 10;

export function PricingSelector() {
  const [volume, setVolume] = useState(250);

  const quote = quoteForVolume(volume);
  const fill = (((volume - MIN) / (MAX - MIN)) * 100).toFixed(1) + '%';

  return (
    <div className="lop-panel pcalc">
      <div className="rglow" aria-hidden />

      <div className="pc-top">
        <label htmlFor="volRange">¿Cuántos envíos hacés por mes?</label>
        <output htmlFor="volRange">
          {fmt(volume)} <small>ENVÍOS</small>
        </output>
      </div>

      <input
        type="range"
        id="volRange"
        min={MIN}
        max={MAX}
        step={STEP}
        value={volume}
        onChange={(e) => setVolume(parseInt(e.target.value, 10))}
        style={{ '--fill': fill } as CSSProperties}
      />
      <div className="marks" aria-hidden>
        <span>10</span>
        <span>250</span>
        <span>500</span>
        <span>750</span>
        <span>1000</span>
      </div>

      <div className="flex flex-wrap justify-center gap-2 mt-5">
        {VOLUME_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setVolume(n)}
            aria-pressed={volume === n}
            className={`rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors ${
              volume === n
                ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200'
                : 'border-white/[0.08] text-zinc-400 hover:border-white/25 hover:text-white'
            }`}
          >
            {fmt(n)}
          </button>
        ))}
      </div>

      <div className="pc-out">
        <div className="pcstat">
          <b>{quote.pricePerShipmentUyu}</b>
          <span>
            UYU por envío
            <br />
            en ese pack
          </span>
        </div>
        <div className="pcstat soft">
          <b>{fmt(quote.totalPriceUyu)}</b>
          <span>
            UYU en total
            <br />
            {quote.quantity > 1
              ? `${quote.quantity} × pack de ${fmt(quote.pack.shipments)}`
              : `pack de ${fmt(quote.pack.shipments)} envíos`}
          </span>
        </div>
        <div className="pcstat">
          <b>{quote.savingsVsBaseUyu > 0 ? fmt(quote.savingsVsBaseUyu) : '—'}</b>
          <span>
            UYU menos que
            <br />
            al precio de lista
          </span>
        </div>
      </div>

      <p className="mt-5 text-center text-[13px] leading-relaxed text-zinc-400">
        {quote.nextTier ? (
          <>
            Con {fmt(quote.nextTier.shipmentsMore)} envíos más pasás al pack de{' '}
            {fmt(quote.nextTier.pack.shipments)} y cada envío te sale{' '}
            <span className="font-semibold text-white">
              {quote.nextTier.pricePerShipmentUyu} UYU
            </span>
            .
          </>
        ) : (
          <>Es el precio por envío más bajo del tarifario.</>
        )}
      </p>

      <div className="cta-inline">
        <Link
          href="/signup"
          className="group inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-7 py-3.5 font-display text-sm font-bold text-zinc-950 shadow-lg shadow-cyan-500/30 transition-all hover:-translate-y-0.5 hover:bg-cyan-400 hover:shadow-cyan-500/50"
        >
          Empezar con 5 envíos gratis
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </Link>
      </div>

      <p className="foot">
        precio de lista {BASE_PRICE_PER_SHIPMENT_UYU} UYU por envío · pago único, sin suscripción ·
        los envíos no vencen
      </p>
    </div>
  );
}
