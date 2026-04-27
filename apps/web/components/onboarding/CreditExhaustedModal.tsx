'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Zap, X, Gift } from 'lucide-react';
import { CREDIT_PACKS } from '@/lib/credit-packs';

const STORAGE_KEY = 'lf_exhausted_dismissed_at';
const DISMISS_TTL_MS = 1000 * 60 * 30; // 30 min — re-show frequently when at 0

/**
 * Shown when the tenant has hit 0 credits. Soft block — dismissible — but
 * we re-show every 30 min until they top up, because at 0 credits the worker
 * stops processing new orders entirely (gate in
 * apps/worker/src/jobs/scheduler.ts) and silent-blocking is a worse user
 * experience than this banner. Dismissal cool-down lets them work on
 * settings / browse data without being constantly nagged.
 *
 * Hard pause of the worker is intentional: it forces the conversion event.
 * We've already given 10 free shipments — at this point the user has seen
 * the value and the buy-now CTA is the rational next step.
 */
export function CreditExhaustedModal() {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    const ts = window.localStorage.getItem(STORAGE_KEY);
    if (!ts) return false;
    return Date.now() - parseInt(ts, 10) < DISMISS_TTL_MS;
  });

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // localStorage blocked — accept that dismissal won't persist.
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={handleDismiss}
    >
      <div
        className="bg-zinc-950 border border-red-500/20 rounded-2xl max-w-md w-full p-6 shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleDismiss}
          aria-label="Cerrar"
          className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="w-12 h-12 rounded-full bg-red-500/15 ring-1 ring-red-500/30 flex items-center justify-center mb-4">
          <Zap className="w-6 h-6 text-red-400" />
        </div>

        <h2 className="text-xl font-semibold text-white mb-2">
          Te quedaste sin envíos
        </h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-5">
          El worker está pausado hasta que recargues. Tus pedidos de Shopify
          siguen llegando — apenas compres un pack se procesan automáticamente
          en orden (no se pierde ninguno).
        </p>

        {/* Pack-popular preview con precio FIRME — el ahorro vs pack_10 (20
            UYU/envío) se calcula en runtime para no descalibrar si los
            precios cambian. Mostrar el número en el momento exacto de
            máxima intención de compra; pedir click para ver precio es
            tirar conversión. */}
        <PackTeaser onCtaClick={handleDismiss} />

        <Link
          href="/settings/billing"
          onClick={handleDismiss}
          className="block w-full bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-semibold text-sm py-2.5 px-4 rounded-lg text-center transition-colors"
        >
          Comprar 100 envíos · 1.500 UYU
        </Link>
        {/* Cross-sell a referidos: si el costo es objeción, hay alternativa
            sin tarjeta. El kickback del 20% (REFERRAL_KICKBACK_RATE en
            credit-packs.ts) está implementado y funciona. */}
        <Link
          href="/settings/referrals"
          onClick={handleDismiss}
          className="mt-3 flex items-center justify-center gap-1.5 text-xs text-violet-300/90 hover:text-violet-200 transition-colors"
        >
          <Gift className="w-3.5 h-3.5" />
          ¿No querés pagar? Invitá un amigo y ganás 20% de lo que compre
        </Link>
        <button
          onClick={handleDismiss}
          className="block w-full text-xs text-zinc-500 hover:text-zinc-300 mt-3 transition-colors"
        >
          Recordarme más tarde
        </button>
      </div>
    </div>
  );
}

/**
 * Pack-popular teaser con precio + ahorro calculado vs pack_10 (la baseline
 * sin descuento). Se desacopla del componente principal para que el
 * cálculo no se filtre al render del modal. El "ahorrás N%" se computa
 * en runtime, así si alguien cambia los precios en credit-packs.ts el
 * número de la UI sigue verdadero.
 */
function PackTeaser({ onCtaClick }: { onCtaClick: () => void }) {
  const popular = CREDIT_PACKS.pack_100;
  const baseline = CREDIT_PACKS.pack_10;
  if (!popular || !baseline) return null;

  const savingsPct = Math.round(
    ((baseline.pricePerShipmentUyu - popular.pricePerShipmentUyu) /
      baseline.pricePerShipmentUyu) *
      100,
  );
  const totalUyu = popular.totalPriceUyu.toLocaleString('es-UY');
  const perShipmentUyu = popular.pricePerShipmentUyu;

  return (
    <Link
      href="/settings/billing"
      onClick={onCtaClick}
      className="block bg-zinc-900/60 hover:bg-zinc-900 border border-white/[0.06] hover:border-cyan-500/30 rounded-lg p-3 mb-4 transition-colors"
    >
      <div className="flex items-center justify-between text-[11px] mb-1.5">
        <span className="font-semibold text-cyan-300 uppercase tracking-wider">
          Pack más popular
        </span>
        <span className="text-emerald-300 font-medium">
          Ahorrás {savingsPct}%
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-bold text-white tabular-nums">
            {popular.shipments}
          </span>
          <span className="text-xs text-zinc-400">envíos</span>
        </div>
        <div className="text-right">
          <div className="text-base font-bold text-white tabular-nums">
            ${totalUyu} UYU
          </div>
          <div className="text-[11px] text-zinc-500 tabular-nums">
            ${perShipmentUyu} c/u
          </div>
        </div>
      </div>
    </Link>
  );
}
