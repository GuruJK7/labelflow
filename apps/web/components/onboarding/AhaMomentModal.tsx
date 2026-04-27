'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Sparkles, X } from 'lucide-react';

/**
 * Celebrates the user's first successfully completed shipment — the moment
 * they've experienced full end-to-end value. Critical for activation: users
 * who hit the aha moment convert to paid at materially higher rates than
 * those who don't. We use the modal to:
 *   1. Reinforce success ("¡Tu primer envío ya está en camino!").
 *   2. Show the immediately-relevant next step (Etiquetas vs Pedidos).
 *   3. Anchor the credits-pack pitch ("ya gastaste 1 de tus 10 envíos gratis").
 *
 * On dismiss we POST to /api/v1/onboarding/aha-seen which sets
 * Tenant.firstJobCompletedAt. Once set, the layout never re-renders this
 * modal — the celebration only fires once.
 *
 * If the API call fails we still hide locally (best-effort). Worst case the
 * user sees the modal a second time on next load; better than blocking them.
 */
export function AhaMomentModal() {
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  const handleClose = async () => {
    setHidden(true);
    try {
      await fetch('/api/v1/onboarding/aha-seen', { method: 'POST' });
    } catch {
      // Network blip — the modal is hidden locally, server will catch up
      // on next dashboard load (we re-check the COMPLETED label there).
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={handleClose}
    >
      <div
        className="bg-zinc-950 border border-white/[0.08] rounded-2xl max-w-md w-full p-6 shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={handleClose}
          aria-label="Cerrar"
          className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center">
            <CheckCircle2 className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-medium text-amber-300 uppercase tracking-wider">
                Primer envío
              </span>
            </div>
            <h2 className="text-xl font-semibold text-white mt-0.5">
              ¡Tu primer envío salió!
            </h2>
          </div>
        </div>

        <p className="text-sm text-zinc-300 leading-relaxed mb-5">
          Acabamos de generar tu primera etiqueta DAC sin que toques nada.
          Esto es exactamente lo que va a pasar con cada pedido nuevo de Shopify
          — automáticamente, mientras vos te ocupás de vender.
        </p>

        <div className="bg-zinc-900/60 border border-white/[0.06] rounded-lg p-3 mb-5">
          <p className="text-xs text-zinc-400 leading-relaxed">
            <span className="text-zinc-200 font-medium">Tip:</span> tenés{' '}
            <span className="text-cyan-300 font-semibold">10 envíos gratis</span> de
            bienvenida. Cuando los uses, comprá un pack y nunca más se te corta.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Link
            href="/labels"
            onClick={handleClose}
            className="flex-1 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-medium text-sm py-2.5 px-4 rounded-lg text-center transition-colors"
          >
            Ver mi etiqueta
          </Link>
          <button
            onClick={handleClose}
            className="flex-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-medium text-sm py-2.5 px-4 rounded-lg transition-colors"
          >
            Seguir explorando
          </button>
        </div>
      </div>
    </div>
  );
}
