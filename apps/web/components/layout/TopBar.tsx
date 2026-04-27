import Link from 'next/link';
import { Zap, Plus, Gift } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Sticky top bar with credit counter — visible on every dashboard page.
 *
 * The counter is the user's primary "fuel gauge": it's the single most
 * important state they need at-a-glance, since 0 credits stops the worker.
 *
 * Tone tiers (driven by TOTAL — what they can actually ship):
 *   > 5     emerald  (healthy)
 *   2 – 5   amber    (warning)
 *   0 – 1   red      (critical / blocked)
 *
 * Bonus pill: when `bonusCredits > 0` we render a small Gift chip next to the
 * main counter showing "+N gratis". This makes the perk visible (referees
 * SEE that they got bonus envíos) and clarifies why the total is higher than
 * what was paid for. The worker drains bonus first, so when paid credits
 * start dropping, the user already understands their free pool ran out.
 *
 * Click anywhere on the counter goes to /settings/billing. The "+" button
 * is a clearer affordance for "buy more" — both routes resolve to the same
 * pack-purchase flow but the explicit CTA tracks better in funnel analytics.
 */
export function TopBar({
  credits,
  bonusCredits = 0,
}: {
  credits: number;
  bonusCredits?: number;
}) {
  const total = credits + bonusCredits;
  const tone =
    total > 5
      ? {
          ring: 'ring-emerald-500/30',
          bg: 'bg-emerald-500/10',
          text: 'text-emerald-400',
          icon: 'text-emerald-400',
          label: 'Envíos disponibles',
        }
      : total >= 2
      ? {
          ring: 'ring-amber-500/30',
          bg: 'bg-amber-500/10',
          text: 'text-amber-300',
          icon: 'text-amber-400',
          label: 'Pocos envíos',
        }
      : {
          ring: 'ring-red-500/40',
          bg: 'bg-red-500/10',
          text: 'text-red-300',
          icon: 'text-red-400',
          label: total === 0 ? 'Sin envíos' : 'Último envío',
        };

  return (
    <header className="sticky top-0 z-30 backdrop-blur-xl bg-[#050505]/70 border-b border-white/[0.06]">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-end gap-3 pl-16 lg:pl-8">
        <Link
          href="/settings/billing"
          aria-label={`${total} envíos disponibles${
            bonusCredits > 0 ? ` (${bonusCredits} gratis por referido)` : ''
          }. Click para gestionar planes.`}
          className={cn(
            'group flex items-center gap-2.5 pl-2 pr-3 py-1.5 rounded-full ring-1 transition-all hover:scale-[1.02]',
            tone.ring,
            tone.bg,
          )}
        >
          <span
            className={cn(
              'w-7 h-7 rounded-full bg-black/30 flex items-center justify-center',
              tone.icon,
            )}
          >
            <Zap className="w-3.5 h-3.5" strokeWidth={2.5} />
          </span>
          <div className="flex items-baseline gap-1.5 leading-none">
            <span className={cn('text-sm font-semibold tabular-nums', tone.text)}>
              {total}
            </span>
            <span className="text-[11px] uppercase tracking-wider text-zinc-500 hidden sm:inline">
              {tone.label}
            </span>
          </div>
        </Link>

        {bonusCredits > 0 && (
          <Link
            href="/settings/referrals"
            aria-label={`${bonusCredits} envíos gratis por referido. Click para detalles.`}
            title={`${bonusCredits} envíos gratis por entrar como referido — se gastan primero`}
            // Visible en TODOS los breakpoints — el bonus es la señal más
            // fuerte de "este producto te quiere" y la mayoría de usuarios
            // PyME en UY entran por mobile. En <sm el label se acorta a
            // "+N" sin la palabra "gratis" para evitar overflow contra el
            // contador principal y el botón "+".
            className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1 rounded-full ring-1 ring-violet-500/25 bg-violet-500/[0.08] text-violet-300 hover:bg-violet-500/[0.12] transition-colors"
          >
            <Gift className="w-3 h-3" strokeWidth={2.5} />
            <span className="text-[11px] font-medium tabular-nums">
              +{bonusCredits}
              <span className="hidden sm:inline"> gratis</span>
            </span>
          </Link>
        )}

        <Link
          href="/settings/billing"
          aria-label="Comprar más envíos"
          className="w-9 h-9 rounded-full bg-cyan-500/10 ring-1 ring-cyan-500/30 text-cyan-300 flex items-center justify-center hover:bg-cyan-500/20 transition-colors"
        >
          <Plus className="w-4 h-4" strokeWidth={2.5} />
        </Link>
      </div>
    </header>
  );
}
