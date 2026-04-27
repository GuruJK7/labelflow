import Link from 'next/link';
import { Zap, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Sticky top bar with credit counter — visible on every dashboard page.
 *
 * The counter is the user's primary "fuel gauge": it's the single most
 * important state they need at-a-glance, since 0 credits stops the worker.
 *
 * Tone tiers:
 *   > 5     emerald  (healthy)
 *   2 – 5   amber    (warning)
 *   0 – 1   red      (critical / blocked)
 *
 * Click anywhere on the counter goes to /settings/billing. The "+" button
 * is a clearer affordance for "buy more" — both routes resolve to the same
 * pack-purchase flow but the explicit CTA tracks better in funnel analytics.
 */
export function TopBar({ credits }: { credits: number }) {
  const tone =
    credits > 5
      ? {
          ring: 'ring-emerald-500/30',
          bg: 'bg-emerald-500/10',
          text: 'text-emerald-400',
          icon: 'text-emerald-400',
          label: 'Envíos disponibles',
        }
      : credits >= 2
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
          label: credits === 0 ? 'Sin envíos' : 'Último envío',
        };

  return (
    <header className="sticky top-0 z-30 backdrop-blur-xl bg-[#050505]/70 border-b border-white/[0.06]">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-end gap-3 pl-16 lg:pl-8">
        <Link
          href="/settings/billing"
          aria-label={`${credits} envíos disponibles. Click para gestionar planes.`}
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
              {credits}
            </span>
            <span className="text-[11px] uppercase tracking-wider text-zinc-500 hidden sm:inline">
              {tone.label}
            </span>
          </div>
        </Link>

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
