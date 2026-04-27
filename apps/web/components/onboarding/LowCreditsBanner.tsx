'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertCircle, X } from 'lucide-react';

const STORAGE_KEY = 'lf_lowcredits_dismissed_at';
const DISMISS_TTL_MS = 1000 * 60 * 60 * 12; // 12 h — re-show after half a day

/**
 * Soft-warning banner shown above the dashboard content when 1–2 credits
 * remain. Dismissible client-side with a 12-hour cool-down so we don't
 * nag every page-load, but the user still sees it again later in the day
 * if they haven't bought a pack.
 *
 * 0 credits is handled by `<CreditExhaustedModal>` (harder block) — this
 * component only renders for the 1–2 range.
 */
export function LowCreditsBanner({ credits }: { credits: number }) {
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
      // localStorage may be blocked (private mode) — fall through, banner
      // just won't persist its dismissal across reloads. Acceptable.
    }
  };

  const message =
    credits === 1
      ? 'Te queda 1 envío. Comprá un pack para seguir despachando sin pausas.'
      : `Te quedan ${credits} envíos. Aprovechá para reponer antes que se acaben.`;

  return (
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-amber-100">{message}</p>
        <Link
          href="/settings/billing"
          className="text-xs font-medium text-amber-300 hover:text-amber-200 underline underline-offset-2 mt-0.5 inline-block"
        >
          Comprar pack →
        </Link>
      </div>
      <button
        onClick={handleDismiss}
        aria-label="Ocultar aviso"
        className="text-amber-400/60 hover:text-amber-300 transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
