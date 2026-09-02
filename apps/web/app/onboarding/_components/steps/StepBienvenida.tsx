'use client';

import { Rocket, Check, Circle } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { OnboardingState } from '@/lib/onboarding-state';
import { StepCard, StepHeader, PrimaryButton } from '../wizard-ui';

/**
 * Paso 1 — Bienvenida. Checklist en una sola columna con tiempo estimado por
 * paso; el estado de cada uno sale de `state` (una tienda ya conectada
 * aparece tildada aunque el usuario recién llegue).
 */
export function StepBienvenida({ state, onStart }: { state: OnboardingState; onStart: () => void }) {
  const items: Array<{ title: string; estimate: string; text: string; done: boolean }> = [
    { title: 'Conectar tu tienda', estimate: '2 min', text: 'Shopify con un botón, o tu Dashboard con Excel.', done: state.store.kind !== null },
    { title: 'Tu cuenta de DAC', estimate: '1 min', text: 'Usuario y contraseña con los que entrás a dac.com.uy.', done: state.dac.connected },
    { title: 'Cómo querés que se procesen los pedidos', estimate: '3 min', text: 'Quién paga el envío, envío gratis, qué productos, aviso al cliente.', done: false },
    { title: 'Cada cuánto', estimate: '30 seg', text: 'Al instante o una vez por hora.', done: false },
    { title: 'Listo', estimate: '', text: `Te regalamos ${state.trialShipments} envíos para probar. Procesás el primero ahí mismo.`, done: state.onboardingComplete },
  ];

  return (
    <StepCard>
      <StepHeader
        icon={Rocket}
        title="Vamos a dejar tus envíos en automático"
        text="Son 5 pasos cortos. Cuando termines, cada pedido pago de tu tienda va a salir solo con su guía de DAC y su etiqueta lista para imprimir."
      />

      <ol className="space-y-2">
        {items.map((it, i) => (
          <li
            key={it.title}
            className={cn(
              'flex items-start gap-3 p-3 rounded-xl border',
              it.done ? 'bg-emerald-500/[0.06] border-emerald-500/20' : 'bg-white/[0.02] border-white/[0.06]',
            )}
          >
            <div className={cn('w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5', it.done ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/[0.04] text-zinc-500')}>
              {it.done ? <Check className="w-3.5 h-3.5" /> : <Circle className="w-3 h-3" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-white">
                  {i + 1}. {it.title}
                </p>
                {it.estimate && <span className="text-[11px] text-zinc-500 flex-shrink-0">{it.estimate}</span>}
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">{it.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-6">
        <PrimaryButton onClick={onStart} className="w-full sm:w-auto">
          Empezar
        </PrimaryButton>
      </div>

      <p className="text-xs text-zinc-500 mt-5 leading-relaxed">
        Necesitás una cuenta de DAC activa. Si todavía no tenés, la pedís en dac.com.uy y volvés cuando la tengas: lo que cargues acá queda guardado.
      </p>
    </StepCard>
  );
}
