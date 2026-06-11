'use client';

import { useState } from 'react';
import { Calculator } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { RoiCalculator } from './RoiCalculator';
import { StressTest } from './StressTest';

/**
 * Two interactive simulators (ROI "¿cuánto te cuesta el manual?" + stress test
 * "¿y cuando el volumen crece?") collapsed into one section with a tab switch, so
 * they don't eat vertical space and the visitor picks which one to see.
 */

type Tab = 'roi' | 'estres';

const TABS: { key: Tab; q: string; sub: string }[] = [
  {
    key: 'roi',
    q: '¿Cuánto te cuesta hoy el proceso manual?',
    sub: 'Mové el slider a tu volumen real y mirá lo que estás dejando en la mesa cada mes.',
  },
  {
    key: 'estres',
    q: '¿Y cuando el volumen crece?',
    sub: 'Subí el slider a un día de alta demanda y mirá quién aguanta el ritmo.',
  },
];

export function Simulators({ whatsappUrl }: { whatsappUrl: string }) {
  const [active, setActive] = useState<Tab>('roi');
  const current = active === 'roi' ? TABS[0] : TABS[1];

  return (
    <section id="simuladores" className="py-16 md:py-24 px-4 sm:px-6">
      <div className="max-w-5xl mx-auto">
        <ScrollReveal>
          <div className="relative isolate text-center mb-8 sm:mb-10">
            <span aria-hidden className="lop-ghost">02</span>
            <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-5 font-mono">
              <Calculator className="w-3.5 h-3.5" />
              Simulá tu operación
            </div>

            <div
              role="tablist"
              aria-label="Elegí qué simular"
              className="flex flex-col sm:flex-row items-stretch justify-center gap-2.5 max-w-2xl mx-auto"
            >
              {TABS.map((t) => {
                const on = active === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setActive(t.key)}
                    className={`flex-1 rounded-xl px-5 py-3.5 font-display text-sm sm:text-base font-bold leading-tight tracking-tight transition-all border ${
                      on
                        ? 'bg-gradient-to-r from-cyan-400/[0.18] to-emerald-400/[0.10] border-cyan-400/40 text-white shadow-lg shadow-cyan-500/10'
                        : 'bg-white/[0.02] border-white/[0.08] text-zinc-400 hover:text-white hover:border-white/20'
                    }`}
                  >
                    {t.q}
                  </button>
                );
              })}
            </div>

            <p className="text-zinc-400 max-w-2xl mx-auto mt-5 leading-relaxed text-sm sm:text-base">
              {current.sub}
            </p>
          </div>
        </ScrollReveal>

        <ScrollReveal variant="scale">
          {active === 'roi' ? <RoiCalculator whatsappUrl={whatsappUrl} /> : <StressTest />}
        </ScrollReveal>
      </div>
    </section>
  );
}
