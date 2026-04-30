'use client';

import { useState, useEffect, useRef, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Zap,
  ShoppingBag,
  Truck,
  ArrowRight,
  ArrowLeft,
  Check,
  Loader2,
  ExternalLink,
  AlertCircle,
  CheckCircle,
  Sparkles,
  Rocket,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { ShopifyTutorial } from './_components/ShopifyTutorial';
import { DacTutorial } from './_components/DacTutorial';
import { track } from '@/lib/analytics';

/**
 * Onboarding wizard — 2 mandatory connection steps + 1 celebration step.
 *
 * Why mandatory:
 *   The app is useless without Shopify (orders source) and DAC (label
 *   destination). Letting users skip leaves them on a dashboard full of
 *   empty states and they bounce. Forcing the wizard up-front guarantees
 *   they hit the activation moment (first auto-shipment) within minutes
 *   of signup, which is the strongest predictor of paid conversion.
 *
 * Each step has its own tutorial collapsible so users without prior
 * Shopify dev-app experience can complete setup unaided. The final step
 * doesn't sell — it nudges them toward the dashboard where their 10 free
 * shipments will start being consumed by real orders. Pack-purchase only
 * shows up after they've felt the value (LowCreditsBanner / aha modal).
 */
type Step = 1 | 2 | 3;

const STEPS = [
  { number: 1, title: 'Shopify', description: 'Conectá tu tienda', icon: ShoppingBag },
  { number: 2, title: 'DAC',     description: 'Tus credenciales',  icon: Truck       },
  { number: 3, title: 'Listo',   description: '¡A despachar!',     icon: Rocket      },
] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Step 1 — Shopify
  const [shopifyUrl, setShopifyUrl] = useState('');
  const [shopifyToken, setShopifyToken] = useState('');
  const [shopifyVerified, setShopifyVerified] = useState(false);
  const [shopifyShopName, setShopifyShopName] = useState<string | null>(null);

  // Step 2 — DAC
  const [dacUsername, setDacUsername] = useState('');
  const [dacPassword, setDacPassword] = useState('');
  const [dacSaved, setDacSaved] = useState(false);

  // Analytics — track time spent on each step + global wizard start.
  // We use refs (not state) because these timestamps don't drive any
  // re-render; mutating them on step change shouldn't trigger React.
  const wizardStartedAtRef = useRef<number>(Date.now());
  const stepStartedAtRef = useRef<number>(Date.now());

  // Fire `onboarding_started` exactly once per page mount. The user can
  // cycle through steps without remounting (state-driven), so a useEffect
  // with [] deps is the right shape.
  useEffect(() => {
    track('onboarding_started');
  }, []);

  // Reset the per-step timer whenever the step changes so the
  // `time_on_step_seconds` property reports time spent on the CURRENT
  // step, not since the wizard mounted.
  useEffect(() => {
    stepStartedAtRef.current = Date.now();
  }, [step]);

  const inputClass =
    'w-full px-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all';
  const labelClass = 'block text-xs font-medium text-zinc-400 mb-1.5';

  async function handleShopifyTest(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!shopifyUrl || !shopifyToken) {
      setError('Completá URL y token de Shopify');
      return;
    }
    // Strip protocol if user pasted https://, normalize.
    const cleanUrl = shopifyUrl
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    setBusy(true);
    try {
      const res = await fetch('/api/v1/onboarding/test-shopify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopifyStoreUrl: cleanUrl,
          shopifyToken: shopifyToken.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        track('onboarding_step_failed', {
          step: 'shopify',
          step_number: 1,
          // No error_message — could leak token shape / shop URL. Status
          // code is enough to bucket failures (401, 403, 422, 500).
          error_code: res.status,
        });
        setError(data.error ?? 'No se pudo verificar Shopify');
        return;
      }
      const seconds = Math.round((Date.now() - stepStartedAtRef.current) / 1000);
      track('onboarding_step_completed', {
        step: 'shopify',
        step_number: 1,
        time_on_step_seconds: seconds,
      });
      setShopifyVerified(true);
      setShopifyShopName(data.data?.shopName ?? null);
      // Auto-advance after a beat so the user sees the green confirmation.
      setTimeout(() => {
        setStep(2);
        setError('');
      }, 900);
    } catch {
      track('onboarding_step_failed', {
        step: 'shopify',
        step_number: 1,
        error_code: 'network',
      });
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDacSave(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!dacUsername || !dacPassword) {
      setError('Completá usuario y contraseña de DAC');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/onboarding/test-dac', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dacUsername: dacUsername.trim(),
          dacPassword: dacPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        track('onboarding_step_failed', {
          step: 'dac',
          step_number: 2,
          error_code: res.status,
        });
        setError(data.error ?? 'No se pudo guardar las credenciales');
        return;
      }
      const seconds = Math.round((Date.now() - stepStartedAtRef.current) / 1000);
      track('onboarding_step_completed', {
        step: 'dac',
        step_number: 2,
        time_on_step_seconds: seconds,
      });
      setDacSaved(true);
      setTimeout(() => {
        setStep(3);
        setError('');
      }, 900);
    } catch {
      track('onboarding_step_failed', {
        step: 'dac',
        step_number: 2,
        error_code: 'network',
      });
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/v1/onboarding/complete', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'No se pudo completar el setup');
        setBusy(false);
        return;
      }
      const totalSeconds = Math.round(
        (Date.now() - wizardStartedAtRef.current) / 1000,
      );
      track('onboarding_completed', { total_time_seconds: totalSeconds });
      // Hard navigation, not router.push — the dashboard layout reads
      // onboardingComplete from the DB on render, so we want a fresh request
      // with no stale cached layout.
      window.location.href = '/dashboard';
    } catch {
      setError('Error de conexión. Probá de nuevo.');
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col">
      {/* Header — no "skip" button: onboarding is required. */}
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
            Setup inicial — toma 2 minutos
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="max-w-3xl mx-auto w-full px-6 pt-8">
        <div className="flex items-center gap-4 mb-8">
          {STEPS.map((s, i) => {
            const isActive = s.number === step;
            const isCompleted =
              s.number < step ||
              (s.number === 1 && shopifyVerified) ||
              (s.number === 2 && dacSaved);
            const StepIcon = s.icon;
            return (
              <div key={s.number} className="flex items-center flex-1">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div
                    className={cn(
                      'w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 flex-shrink-0',
                      isCompleted
                        ? 'bg-emerald-500/20 border border-emerald-500/30'
                        : isActive
                          ? 'bg-cyan-500/20 border border-cyan-500/30'
                          : 'bg-white/[0.03] border border-white/[0.06]',
                    )}
                  >
                    {isCompleted ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <StepIcon
                        className={cn(
                          'w-4 h-4',
                          isActive ? 'text-cyan-400' : 'text-zinc-600',
                        )}
                      />
                    )}
                  </div>
                  <div className="hidden sm:block min-w-0">
                    <p
                      className={cn(
                        'text-xs font-medium truncate',
                        isActive ? 'text-white' : 'text-zinc-500',
                      )}
                    >
                      {s.title}
                    </p>
                    <p className="text-[10px] text-zinc-600 truncate">{s.description}</p>
                  </div>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={cn(
                      'h-px flex-1 mx-3',
                      isCompleted ? 'bg-emerald-500/30' : 'bg-white/[0.06]',
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center px-6 pb-12">
        <div className="w-full max-w-3xl">
          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* STEP 1 — Shopify */}
          {step === 1 && (
            <div className="space-y-4 animate-fade-in">
              <div className="glass rounded-2xl p-6 sm:p-8">
                <div className="flex items-start gap-3 mb-1">
                  <div className="w-10 h-10 rounded-xl bg-cyan-500/15 ring-1 ring-cyan-500/30 flex items-center justify-center flex-shrink-0">
                    <ShoppingBag className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">Conectá tu tienda Shopify</h2>
                    <p className="text-zinc-500 text-sm mt-0.5">
                      Leemos tus pedidos para generar las etiquetas DAC automáticamente.
                    </p>
                  </div>
                </div>

                <ShopifyTutorial />

                <form onSubmit={handleShopifyTest} className="space-y-4 mt-6">
                  <div>
                    <label className={labelClass}>URL de la tienda</label>
                    <input
                      value={shopifyUrl}
                      onChange={(e) => {
                        setShopifyUrl(e.target.value);
                        setShopifyVerified(false);
                      }}
                      className={inputClass}
                      placeholder="mi-tienda.myshopify.com"
                      autoComplete="off"
                      required
                    />
                    <p className="text-[10px] text-zinc-600 mt-1">
                      El dominio que termina en .myshopify.com (no el dominio personalizado).
                    </p>
                  </div>
                  <div>
                    <label className={labelClass}>Admin API Access Token</label>
                    <input
                      type="password"
                      value={shopifyToken}
                      onChange={(e) => {
                        setShopifyToken(e.target.value);
                        setShopifyVerified(false);
                      }}
                      className={inputClass}
                      placeholder="shpat_xxxxxxxxxxxxxxxxx"
                      autoComplete="off"
                      required
                    />
                  </div>

                  {shopifyVerified && (
                    <div className="flex items-center gap-2 text-emerald-400 text-sm bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                      <CheckCircle className="w-4 h-4 flex-shrink-0" />
                      <span>
                        Conectado{shopifyShopName ? ` a ${shopifyShopName}` : ''}. Pasamos al
                        siguiente paso…
                      </span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={busy || shopifyVerified}
                    className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white py-3 rounded-xl text-sm font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {busy ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Verificando con Shopify…
                      </>
                    ) : shopifyVerified ? (
                      <>
                        <Check className="w-4 h-4" />
                        Verificado
                      </>
                    ) : (
                      <>
                        Verificar y continuar
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* STEP 2 — DAC */}
          {step === 2 && (
            <div className="space-y-4 animate-fade-in">
              <div className="glass rounded-2xl p-6 sm:p-8">
                <div className="flex items-start gap-3 mb-1">
                  <div className="w-10 h-10 rounded-xl bg-cyan-500/15 ring-1 ring-cyan-500/30 flex items-center justify-center flex-shrink-0">
                    <Truck className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">Conectá tu cuenta DAC</h2>
                    <p className="text-zinc-500 text-sm mt-0.5">
                      Las mismas credenciales que usás en{' '}
                      <a
                        href="https://www.dac.com.uy"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1"
                      >
                        dac.com.uy <ExternalLink className="w-3 h-3" />
                      </a>
                    </p>
                  </div>
                </div>

                <DacTutorial />

                <form onSubmit={handleDacSave} className="space-y-4 mt-6">
                  <div>
                    <label className={labelClass}>Documento / RUT</label>
                    <input
                      value={dacUsername}
                      onChange={(e) => {
                        setDacUsername(e.target.value);
                        setDacSaved(false);
                      }}
                      className={inputClass}
                      placeholder="Ej: 12345678 o tu RUT"
                      autoComplete="off"
                      required
                    />
                    <p className="text-[10px] text-zinc-600 mt-1">
                      Cédula de identidad o RUT, igual que en el portal DAC.
                    </p>
                  </div>
                  <div>
                    <label className={labelClass}>Contraseña</label>
                    <input
                      type="password"
                      value={dacPassword}
                      onChange={(e) => {
                        setDacPassword(e.target.value);
                        setDacSaved(false);
                      }}
                      className={inputClass}
                      placeholder="Tu contraseña de DAC"
                      autoComplete="off"
                      required
                    />
                    <p className="text-[10px] text-zinc-600 mt-1">
                      Se guarda cifrada (AES-256). Sólo se usa para que el bot inicie sesión.
                    </p>
                  </div>

                  {dacSaved && (
                    <div className="flex items-center gap-2 text-emerald-400 text-sm bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                      <CheckCircle className="w-4 h-4 flex-shrink-0" />
                      <span>Credenciales guardadas. Casi terminamos…</span>
                    </div>
                  )}

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setStep(1);
                        setError('');
                      }}
                      className="px-5 py-3 rounded-xl border border-white/[0.08] text-zinc-400 text-sm hover:bg-white/[0.03] transition-colors flex items-center gap-1"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" /> Atrás
                    </button>
                    <button
                      type="submit"
                      disabled={busy || dacSaved}
                      className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white py-3 rounded-xl text-sm font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {busy ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Guardando…
                        </>
                      ) : dacSaved ? (
                        <>
                          <Check className="w-4 h-4" />
                          Guardado
                        </>
                      ) : (
                        <>
                          Guardar y continuar
                          <ArrowRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* STEP 3 — Activación */}
          {step === 3 && (
            <div className="animate-fade-in">
              <div className="glass rounded-2xl p-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 ring-1 ring-emerald-500/40 flex items-center justify-center mx-auto mb-4">
                  <Sparkles className="w-7 h-7 text-emerald-300" />
                </div>

                <h2 className="text-2xl font-bold text-white mb-2">
                  ¡Configuración lista!
                </h2>
                <p className="text-zinc-400 text-sm mb-6 max-w-md mx-auto">
                  Tu tienda y DAC están conectados. A partir de ahora cada pedido nuevo
                  de Shopify se procesa solo: leemos la dirección, generamos la guía DAC
                  e imprimimos la etiqueta — sin que vos toques nada.
                </p>

                <div className="bg-cyan-500/[0.06] border border-cyan-500/20 rounded-xl p-4 mb-6 text-left max-w-md mx-auto">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="w-4 h-4 text-cyan-400" />
                    <span className="text-sm font-semibold text-white">10 envíos gratis</span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Te regalamos 10 envíos para que pruebes el flujo completo. No se
                    vencen. Cuando los uses, comprás un pack y seguís sin pausas.
                  </p>
                </div>

                <ul className="space-y-2 mb-7 max-w-md mx-auto text-left">
                  <li className="flex items-start gap-2.5 text-sm text-zinc-300">
                    <div className="w-5 h-5 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-emerald-400" />
                    </div>
                    <span>
                      <strong className="text-white">Pedidos en tiempo real</strong> —
                      tu tienda se sincroniza cada 15 minutos.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5 text-sm text-zinc-300">
                    <div className="w-5 h-5 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-emerald-400" />
                    </div>
                    <span>
                      <strong className="text-white">Guías DAC automáticas</strong> —
                      generamos la guía y te avisamos si algo falla.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5 text-sm text-zinc-300">
                    <div className="w-5 h-5 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-emerald-400" />
                    </div>
                    <span>
                      <strong className="text-white">Cero data entry</strong> — el bot
                      hace el copy-paste por vos.
                    </span>
                  </li>
                </ul>

                <button
                  onClick={handleFinish}
                  disabled={busy}
                  className="w-full sm:w-auto px-8 inline-flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white py-3 rounded-xl text-sm font-medium transition-all disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      Ir al dashboard
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setStep(2);
                    setError('');
                  }}
                  className="block w-full text-xs text-zinc-600 hover:text-zinc-400 transition-colors mt-4"
                >
                  ← Revisar credenciales DAC
                </button>
              </div>
            </div>
          )}

          {/* Trust footer */}
          <div className="text-center mt-6">
            <p className="text-[11px] text-zinc-700">
              🔒 Tus credenciales se guardan cifradas con AES-256. Sólo el bot las usa
              para iniciar sesión.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
