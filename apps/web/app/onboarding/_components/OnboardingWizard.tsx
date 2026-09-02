'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Zap, Check, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';
import { track } from '@/lib/analytics';
import { ONBOARDING_STEPS, type OnboardingState, type OnboardingStep } from '@/lib/onboarding-state';
import { StepBienvenida } from './steps/StepBienvenida';
import { StepTienda, type OAuthReturn } from './steps/StepTienda';
import { StepDac } from './steps/StepDac';
import { StepParametros } from './steps/StepParametros';
import { StepModo } from './steps/StepModo';
import { StepListo } from './steps/StepListo';

/**
 * Wizard de onboarding (D33): 6 pasos, obligatorio hasta completar.
 *
 * El estado es el que manda el server (`initial`, derivado de la base). Cada
 * guardado exitoso lo refresca con `GET /api/v1/onboarding/state` y el wizard
 * salta al `currentStep` derivado, SALVO que el usuario esté en 4/5/6: ahí
 * manda el click en Continuar (esos pasos no tienen estado propio).
 *
 * Se puede volver a cualquier paso ya hecho (para editar); nunca saltar a uno
 * pendiente. Sin botón "saltar". Cuando el usuario ya completó y vuelve desde
 * Configuración (`?step=N`), todos los pasos están habilitados.
 */
export function OnboardingWizard({
  initial,
  requestedStep,
}: {
  initial: OnboardingState;
  requestedStep: OnboardingStep | null;
}) {
  const [state, setState] = useState<OnboardingState>(initial);
  const [oauthReturn, setOauthReturn] = useState<OAuthReturn | null>(null);
  const [step, setStep] = useState<OnboardingStep>(() => requestedStep ?? initial.currentStep);
  const [maxVisited, setMaxVisited] = useState<OnboardingStep>(() => requestedStep ?? initial.currentStep);
  const [refreshError, setRefreshError] = useState('');

  const wizardStartedAtRef = useRef<number>(Date.now());
  const stepStartedAtRef = useRef<number>(Date.now());

  // Retorno del OAuth de Shopify (`?shopify=connected|...`): se muestra en el
  // paso 2 y se limpia la URL para que un F5 no repita el mensaje.
  useEffect(() => {
    track('onboarding_started');
    const p = new URLSearchParams(window.location.search);
    const motivo = p.get('shopify');
    if (motivo) {
      setOauthReturn({ motivo, webhooks: p.get('webhooks') });
      setStep(2);
      setMaxVisited((m) => (m > 2 ? m : 2));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    stepStartedAtRef.current = Date.now();
    window.scrollTo({ top: 0 });
  }, [step]);

  const maxReachable: OnboardingStep = state.onboardingComplete
    ? 6
    : (Math.max(maxVisited, state.currentStep) as OnboardingStep);

  const goTo = useCallback((n: OnboardingStep) => {
    setStep(n);
    setMaxVisited((m) => (n > m ? n : m));
  }, []);

  /** Vuelve a leer el estado de la base. Devuelve el nuevo estado (o null si falló). */
  const refresh = useCallback(async (): Promise<OnboardingState | null> => {
    try {
      const res = await fetch('/api/v1/onboarding/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const { data } = (await res.json()) as { data: OnboardingState };
      setState(data);
      setRefreshError('');
      return data;
    } catch {
      setRefreshError('No pudimos actualizar el estado. Lo que guardaste quedó guardado; recargá la página si algo no se refleja.');
      return null;
    }
  }, []);

  function stepCompleted(name: 'tienda' | 'dac' | 'parametros' | 'modo', n: OnboardingStep) {
    track('onboarding_step_completed', {
      step: name,
      step_number: n,
      time_on_step_seconds: Math.round((Date.now() - stepStartedAtRef.current) / 1000),
    });
  }
  function stepFailed(name: 'tienda' | 'dac' | 'modo', n: OnboardingStep, code: string | number) {
    track('onboarding_step_failed', { step: name, step_number: n, error_code: code });
  }

  /** Guardado en un paso con estado (2 o 3): refrescar y saltar a lo derivado. */
  async function afterSave(name: 'tienda' | 'dac', n: OnboardingStep) {
    stepCompleted(name, n);
    const next = await refresh();
    // Un respiro para que se vea la confirmación verde antes de avanzar.
    await new Promise((r) => setTimeout(r, 900));
    if (next && !next.onboardingComplete) {
      // Si la base dice que ya está listo el paso, avanzamos al derivado
      // (2 → 3 → 4); nunca retrocedemos a alguien que está en 4/5/6.
      const target = next.currentStep > n ? next.currentStep : n;
      goTo(target);
    }
  }

  function done(n: OnboardingStep): boolean {
    if (state.onboardingComplete) return true;
    if (n === 1) return step > 1 || state.store.kind !== null || state.dac.connected;
    if (n === 2) return state.store.kind !== null;
    if (n === 3) return state.dac.connected;
    if (n === 4) return maxVisited > 4;
    if (n === 5) return maxVisited > 5;
    return false;
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col">
      <div className="border-b border-white/[0.04] px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-white text-sm">
              Label<span className="text-cyan-400">Flow</span>
            </span>
          </div>
          <span className="text-[11px] text-zinc-600 hidden sm:block">
            {state.onboardingComplete ? (
              <a href="/settings" className="hover:text-zinc-400">
                Volver a Configuración
              </a>
            ) : (
              'Configuración inicial: unos 9 minutos en total'
            )}
          </span>
        </div>
      </div>

      {/* Progreso: 6 pasos con título y tiempo estimado */}
      <div className="max-w-3xl mx-auto w-full px-6 pt-8">
        <ol className="grid grid-cols-6 gap-1 sm:gap-2 mb-8" aria-label="Progreso">
          {ONBOARDING_STEPS.map((s) => {
            const isActive = s.number === step;
            const isDone = done(s.number) && !isActive;
            const reachable = s.number <= maxReachable;
            return (
              <li key={s.number} className="min-w-0">
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => reachable && goTo(s.number)}
                  aria-current={isActive ? 'step' : undefined}
                  className={cn('w-full text-left group', !reachable && 'cursor-not-allowed')}
                >
                  <div
                    className={cn(
                      'h-1.5 rounded-full mb-2 transition-colors',
                      isActive ? 'bg-cyan-500' : isDone ? 'bg-emerald-500/60' : 'bg-white/[0.08]',
                    )}
                  />
                  <div className="flex items-center gap-1 min-w-0">
                    {isDone ? (
                      <Check className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                    ) : (
                      <span className={cn('text-[10px] font-mono flex-shrink-0', isActive ? 'text-cyan-400' : 'text-zinc-600')}>{s.number}</span>
                    )}
                    <p className={cn('text-[11px] font-medium truncate', isActive ? 'text-white' : isDone ? 'text-zinc-300' : 'text-zinc-600')}>{s.title}</p>
                  </div>
                  {s.estimate && <p className="text-[10px] text-zinc-600 truncate hidden sm:block">{s.estimate}</p>}
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex-1 flex items-start justify-center px-6 pb-12">
        <div className="w-full max-w-3xl">
          {refreshError && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200 text-sm">{refreshError}</div>
          )}

          {step === 1 && <StepBienvenida state={state} onStart={() => goTo(2)} />}

          {step === 2 && (
            <StepTienda
              state={state}
              oauthReturn={oauthReturn}
              onSaved={() => afterSave('tienda', 2)}
              onFailed={(code) => stepFailed('tienda', 2, code)}
              onContinue={() => {
                stepCompleted('tienda', 2);
                goTo(3);
              }}
              onBack={() => goTo(1)}
            />
          )}

          {step === 3 && (
            <StepDac
              state={state}
              onSaved={() => afterSave('dac', 3)}
              onFailed={(code) => stepFailed('dac', 3, code)}
              onContinue={() => {
                stepCompleted('dac', 3);
                goTo(4);
              }}
              onBack={() => goTo(2)}
            />
          )}

          {step === 4 && (
            <StepParametros
              state={state}
              onSaved={() => void refresh()}
              onContinue={() => {
                stepCompleted('parametros', 4);
                goTo(5);
              }}
              onBack={() => goTo(3)}
            />
          )}

          {step === 5 && (
            <StepModo
              state={state}
              onSaved={async () => {
                stepCompleted('modo', 5);
                await refresh();
              }}
              onFailed={(code) => stepFailed('modo', 5, code)}
              onContinue={() => goTo(6)}
              onBack={() => goTo(4)}
            />
          )}

          {step === 6 && (
            <StepListo
              state={state}
              onCompleted={() => {
                if (!state.onboardingComplete) {
                  track('onboarding_completed', {
                    total_time_seconds: Math.round((Date.now() - wizardStartedAtRef.current) / 1000),
                  });
                }
              }}
              onBack={() => goTo(5)}
            />
          )}

          <div className="text-center mt-6">
            <p className="text-[11px] text-zinc-600 inline-flex items-center gap-1.5">
              <Lock className="w-3 h-3" />
              Tus credenciales se guardan cifradas (AES-256). Sólo el automatizador las usa para iniciar sesión.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
