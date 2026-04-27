'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Zap, X } from 'lucide-react';

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

        <div className="bg-zinc-900/60 border border-white/[0.06] rounded-lg p-3 mb-5">
          <div className="flex justify-between text-xs text-zinc-400 mb-1">
            <span>Pack más popular</span>
            <span className="text-emerald-400">Mejor precio por envío</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">100</span>
            <span className="text-sm text-zinc-400">envíos</span>
          </div>
        </div>

        <Link
          href="/settings/billing"
          onClick={handleDismiss}
          className="block w-full bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-medium text-sm py-2.5 px-4 rounded-lg text-center transition-colors"
        >
          Ver packs de envíos
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
