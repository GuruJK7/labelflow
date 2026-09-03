'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import { quoteForVolume, VOLUME_PRESETS, SELF_SERVE_PACK_SHIPMENTS } from '@/lib/credit-packs';
import {
  formatTotalPrice,
  formatUnitPrice,
  currencyNote,
  PRICING_TIERS,
  type Currency,
} from '@/lib/pricing';
import { CurrencyToggle, useCurrency } from './CurrencyToggle';
import { TRIAL_SHIPMENTS } from '@/lib/trial';

/**
 * Simulador de precios de la landing.
 *
 * QUÉ COTIZA. El usuario declara envíos por mes y el panel muestra dos números
 * distintos a propósito: lo que le costaría ese mes al precio del escalón
 * (`monthlyTotal*`, el número honesto) y lo que paga si aprieta comprar
 * (`totalPrice*`, el pack más chico que lo cubre, porque los packs vienen en
 * cantidades fijas). Toda la aritmética sale de `quoteForVolume`, la misma
 * tabla que cobra `credit-packs/checkout`: no hay precio que pueda quedar
 * desincronizado con la caja.
 *
 * 🔴 POR QUÉ EL TIPO DE CAMBIO ENTRA POR PROP. `USD_UYU_RATE` es env de
 * servidor. Si este componente llamara a `getUsdUyuRateMilli()` en el browser
 * caería al tipo base y publicaría pesos distintos de los que cobra el
 * checkout. `rateMilliValue` y `rateLabel` bajan desde `page.tsx`, que sí lee
 * la env, y `largePacks` viaja por el mismo motivo: en el navegador
 * `process.env` viene vacío y el catálogo se calcularía distinto en el SSR que
 * en la hidratación.
 */

const fmt = (n: number) => n.toLocaleString('es-UY');

/** Rango del slider: el techo del autoservicio. Arriba de eso se cotiza a medida. */
const MIN = 10;
const MAX = 1000;
const STEP = 10;

/**
 * El volumen más alto que se compra apretando un botón. Los escalones de 2.500
 * y 5.000 existen en el tarifario pero están detrás de `ENABLE_LARGE_CREDIT_PACKS`:
 * prometer su descuento sin decir que se cotiza a medida es prometer un precio
 * que hoy nadie puede pagar solo.
 */
const TECHO_AUTOSERVICIO = SELF_SERVE_PACK_SHIPMENTS[SELF_SERVE_PACK_SHIPMENTS.length - 1];

/**
 * 🔴 EL VOLUMEN ALTO TAMBIÉN ENTRA POR EL ALTA, no por WhatsApp.
 *
 * El WhatsApp es SOPORTE, no un canal de venta: quien quiere el servicio se
 * crea la cuenta, empieza con los envíos de prueba y, si hace más volumen del
 * que se compra en autoservicio, el precio se ajusta desde adentro. Poner un
 * "escribinos" acá reabría un embudo de venta asistida que el producto dejó
 * atrás a propósito cuando se volvió self-serve.
 */
const ALTA = '/signup';

export interface PricingSelectorProps {
  /** `getUsdUyuRateMilli()` leído en el server, como número. */
  rateMilliValue: number;
  /** El mismo tipo ya formateado (`formatRate`), para el texto. */
  rateLabel: string;
  /** `ENABLE_LARGE_CREDIT_PACKS` resuelto en el server. */
  largePacks: boolean;
  /**
   * Moneda controlada desde afuera. Sin esto el componente sólo se puede
   * renderizar en el default: `renderToStaticMarkup` no corre efectos, así que
   * `useCurrency` nunca leería localStorage y la vista en dólares no se podría
   * probar. Mismo contrato que `VolumeSelector`.
   */
  currency?: Currency;
  onCurrencyChange?: (next: Currency) => void;
  /**
   * Volumen de arranque. Existe para poder probar los estados de volumen alto:
   * al slider se llega con eventos, y `renderToStaticMarkup` no dispara ninguno.
   */
  initialVolume?: number;
}

const NOOP = () => {};

export function PricingSelector({
  rateMilliValue,
  rateLabel,
  largePacks,
  currency: currencyProp,
  onCurrencyChange,
  initialVolume = 250,
}: PricingSelectorProps) {
  const [volume, setVolume] = useState(initialVolume);
  // El hook se llama siempre (regla de hooks); su valor se ignora cuando la
  // moneda viene por prop.
  // 🔴 La landing arranca en DÓLARES, no en el default de la app.
  //
  // El precio de lista está denominado en dólares y es el que publica la ficha
  // del App Store; mostrar pesos primero hacía que el número más grande de la
  // sección fuera una conversión y no el precio. En la pantalla de compra el
  // default sigue siendo pesos, que es lo que el comerciante va a pagar por
  // MercadoPago.
  //
  // El selector sigue ahí: quien quiera pesos los ve en un clic, y la elección
  // se persiste igual.
  const [propiaCurrency, setPropiaCurrency] = useCurrency('USD');
  const controlada = currencyProp !== undefined;
  const currency = controlada ? currencyProp : propiaCurrency;
  const setCurrency = onCurrencyChange ?? (controlada ? NOOP : setPropiaCurrency);

  const rateMilli = BigInt(rateMilliValue);
  const money = { currency, rateMilli };
  const quote = quoteForVolume(volume, rateMilli, { largePacks });

  const sliderValue = Math.min(volume, MAX);
  const fill = (((sliderValue - MIN) / (MAX - MIN)) * 100).toFixed(1) + '%';

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
        value={sliderValue}
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

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
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

      <div className="mt-4 flex justify-center">
        <CurrencyToggle value={currency} onChange={setCurrency} label="Ver los precios en" />
      </div>

      <div className="pc-out">
        <div className="pcstat">
          <b>{formatUnitPrice(BigInt(quote.effectiveUnitUsdMilli), money)}</b>
          <span>
            por envío
            <br />
            con {fmt(volume)} al mes
          </span>
        </div>
        <div className="pcstat soft">
          <b>{formatTotalPrice(BigInt(quote.monthlyTotalUsdMilli), money)}</b>
          <span>
            el mes entero
            <br />
            {quote.tierLabel}
          </span>
        </div>
        <div className="pcstat">
          <b>
            {quote.savingsVsBaseUsdMilli > 0
              ? formatTotalPrice(BigInt(quote.savingsVsBaseUsdMilli), money)
              : '—'}
          </b>
          <span>
            menos que al precio
            <br />
            del primer escalón
          </span>
        </div>
      </div>

      <p className="mt-5 text-center text-[13px] leading-relaxed text-zinc-400">
        {quote.needsCustomQuote ? (
          <>
            Arriba de {fmt(quote.pack.shipments)} envíos por mes el precio se arma a medida:{' '}
            <Link
              href={ALTA}
              className="font-semibold text-cyan-300 underline underline-offset-2 hover:text-cyan-200"
            >
              creá tu cuenta
            </Link>{' '}
            y lo ajustamos con vos desde adentro.
          </>
        ) : quote.nextStep && quote.nextStep.savesPerShipmentUsdMilli > 0 ? (
          <>
            Con {fmt(quote.nextStep.shipmentsMore)} envíos más pasás al escalón de{' '}
            {fmt(quote.nextStep.minShipments)} y cada envío te sale{' '}
            <span className="font-semibold text-white">
              {formatUnitPrice(BigInt(quote.nextStep.savesPerShipmentUsdMilli), money)} menos
            </span>
            {/* El descuento es real, pero arriba del techo del autoservicio no se
                compra apretando un botón: decirlo acá evita prometer un precio
                que el cliente después no encuentra en la pantalla de compra. */}
            {quote.nextStep.minShipments > TECHO_AUTOSERVICIO
              ? ' —ese escalón se ajusta a medida, desde tu cuenta.'
              : '.'}
          </>
        ) : (
          <>Ya estás en el mejor precio por envío del tarifario.</>
        )}
      </p>

      <div className="cta-inline">
        <Link
          href="/signup"
          className="group inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-7 py-3.5 font-display text-sm font-bold text-zinc-950 shadow-lg shadow-cyan-500/30 transition-all hover:-translate-y-0.5 hover:bg-cyan-400 hover:shadow-cyan-500/50"
        >
          Empezar con {TRIAL_SHIPMENTS} envíos gratis
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden />
        </Link>
      </div>

      <p className="foot">
        precio de lista {formatUnitPrice(PRICING_TIERS[0].unitPriceUsdMilli, money)} por envío y baja
        con el volumen · pago único, sin suscripción · los envíos no vencen
      </p>

      <p className="mx-auto mt-3 max-w-xl text-center text-[11px] leading-relaxed text-zinc-500">
        {currencyNote(currency, rateLabel)}
      </p>
    </div>
  );
}
