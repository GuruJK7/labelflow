import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { ONBOARDING_STEPS } from '@/lib/onboarding-state';

/**
 * Atajos al asistente de configuración (D33): desde Configuración se puede
 * volver a cualquier paso del wizard (`/onboarding?step=N`) para editarlo
 * con las explicaciones completas. Sin estado: el wizard lee la base.
 */
export function WizardShortcuts() {
  return (
    <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <ListChecks className="w-4 h-4 text-cyan-400" />
        <h2 className="text-sm font-semibold text-white">Asistente de configuración</h2>
      </div>
      <p className="text-xs text-zinc-500 mb-3">
        Volvé a cualquier paso, con la explicación completa de cada opción.
      </p>
      <div className="flex flex-wrap gap-2">
        {ONBOARDING_STEPS.filter((s) => s.number >= 2).map((s) => (
          <Link
            key={s.number}
            href={`/onboarding?step=${s.number}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-white/[0.08] text-zinc-300 hover:text-white hover:border-cyan-500/40 hover:bg-cyan-500/[0.06] transition-colors"
          >
            <span className="font-mono text-[10px] text-zinc-500">{s.number - 1}</span>
            {s.title}
          </Link>
        ))}
      </div>
    </div>
  );
}
