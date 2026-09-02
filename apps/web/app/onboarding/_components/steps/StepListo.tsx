'use client';

import { useState } from 'react';
import { Sparkles, Zap, Check, ShoppingBag, Truck, Clock } from 'lucide-react';
import type { OnboardingState } from '@/lib/onboarding-state';
import { StepCard, PrimaryButton, SecondaryButton, Notice } from '../wizard-ui';

/**
 * Paso 6 — Listo. Muestra los envíos gratis (constante) y el saldo REAL del
 * holder, el resumen de lo configurado y activa la cuenta:
 *   - "Activar y procesar ahora": `POST /api/v1/onboarding/complete` y, si
 *     salió bien, `POST /api/v1/jobs` (el tipo lo decide el server según la
 *     tienda). Si el job falla (403/409/422) igual se va al dashboard con el
 *     mensaje: la cuenta ya quedó activa.
 *   - "Activar sin procesar": sólo `complete`.
 * Si el usuario ya había completado (viene desde Configuración), no se
 * vuelve a activar nada: sólo "Procesar ahora" y volver.
 */
export function StepListo({
  state,
  onCompleted,
  onBack,
}: {
  state: OnboardingState;
  onCompleted: () => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState<'' | 'activar' | 'activar-sin' | 'procesar'>('');
  const [error, setError] = useState('');
  const [verifyHref, setVerifyHref] = useState('');
  const yaCompleto = state.onboardingComplete;

  async function complete(): Promise<boolean> {
    const res = await fetch('/api/v1/onboarding/complete', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? 'No se pudo activar la cuenta');
      setVerifyHref(data.code === 'email_not_verified' ? `/verify-email?email=${encodeURIComponent(data.email ?? state.email ?? '')}` : '');
      return false;
    }
    return true;
  }

  async function procesar(): Promise<string | null> {
    const res = await fetch('/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error ?? 'No se pudo encolar el procesamiento';
  }

  function goDashboard(jobError?: string | null) {
    onCompleted();
    if (jobError) {
      // La cuenta ya quedó activa; el job no se pudo encolar (sin saldo, uno
      // en curso…). Se muestra el motivo y el usuario sigue al dashboard.
      setError(`${jobError} Tu cuenta quedó activa igual.`);
      setTimeout(() => {
        window.location.href = '/dashboard';
      }, 2500);
      return;
    }
    // Navegación dura: el layout del dashboard lee onboardingComplete de la
    // base en cada request y no queremos un layout cacheado.
    window.location.href = '/dashboard';
  }

  async function activarYProcesar() {
    setError('');
    setBusy('activar');
    try {
      if (!yaCompleto && !(await complete())) return;
      const jobError = await procesar();
      goDashboard(jobError);
    } catch {
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setBusy('');
    }
  }

  async function activarSinProcesar() {
    setError('');
    setBusy('activar-sin');
    try {
      if (!yaCompleto && !(await complete())) return;
      goDashboard();
    } catch {
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setBusy('');
    }
  }

  const modoLabel = state.processingMode === 'inmediato' ? 'Inmediato' : state.processingMode === 'cada_hora' ? 'Cada hora' : 'Horario personalizado';
  const tiendaLabel =
    state.store.kind === 'shopify'
      ? `Shopify: ${state.store.shopifyStoreUrl ?? ''}`
      : state.store.kind === 'dashboard'
        ? `Dashboard con Excel: ${state.store.dashboardUrl ?? ''}`
        : 'Sin tienda conectada';
  const emailOk = state.emailVerified;
  const bloqueado = !yaCompleto && !emailOk;

  return (
    <StepCard className="text-center">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/30 to-cyan-500/30 ring-1 ring-emerald-500/40 flex items-center justify-center mx-auto mb-4">
        <Sparkles className="w-7 h-7 text-emerald-300" />
      </div>
      <h2 className="text-2xl font-bold text-white mb-2">Todo listo</h2>
      <p className="text-zinc-400 text-sm mb-6 max-w-md mx-auto">
        {yaCompleto
          ? 'Tu cuenta ya está activa. Podés revisar lo configurado o procesar los pedidos pendientes ahora.'
          : 'Revisá el resumen y activá la cuenta. Desde ese momento cada pedido pago sale solo.'}
      </p>

      <div className="bg-cyan-500/[0.06] border border-cyan-500/20 rounded-xl p-4 mb-4 text-left max-w-md mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <Zap className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-semibold text-white">{state.trialShipments} envíos gratis</span>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Te los acreditamos para que pruebes el flujo completo. No vencen. Cuando los uses, comprás envíos y seguís sin pausas.
        </p>
        <p className="text-xs text-zinc-300 mt-2">
          Saldo disponible: <strong className="text-white">{state.balance.total}</strong> {state.balance.total === 1 ? 'envío' : 'envíos'}
          {state.balance.total < state.trialShipments && <span className="text-zinc-500"> · Tu saldo es compartido entre todas tus tiendas.</span>}
        </p>
      </div>

      <ul className="space-y-2 mb-6 max-w-md mx-auto text-left">
        <Resumen icon={ShoppingBag} label="Tienda" value={tiendaLabel} />
        <Resumen icon={Truck} label="DAC" value={state.dac.username ? `Usuario ${state.dac.username}` : 'Cuenta guardada'} />
        <Resumen icon={Clock} label="Modo" value={modoLabel} />
      </ul>

      {bloqueado && (
        <div className="max-w-md mx-auto mb-4 text-left">
          <Notice kind="warn">
            Confirmá tu email para activar la cuenta. Te mandamos un link al registrarte.{' '}
            <a href={`/verify-email?email=${encodeURIComponent(state.email ?? '')}`} className="underline hover:text-white">
              Reenviar
            </a>
          </Notice>
        </div>
      )}
      {error && (
        <div className="max-w-md mx-auto mb-4 text-left">
          <Notice kind="error">
            {error}
            {verifyHref && (
              <>
                {' '}
                <a href={verifyHref} className="underline hover:text-white">
                  Reenviar el mail de confirmación
                </a>
              </>
            )}
          </Notice>
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <PrimaryButton onClick={activarYProcesar} busy={busy === 'activar'} busyLabel={yaCompleto ? 'Encolando…' : 'Activando…'} disabled={bloqueado || busy !== ''} className="w-full sm:w-auto px-8">
          {yaCompleto ? 'Procesar ahora' : 'Activar y procesar ahora'}
        </PrimaryButton>
        <SecondaryButton onClick={activarSinProcesar} disabled={bloqueado || busy !== ''} className="w-full sm:w-auto">
          {busy === 'activar-sin' ? 'Un momento…' : yaCompleto ? 'Ir al dashboard' : 'Activar sin procesar'}
        </SecondaryButton>
      </div>

      <ul className="space-y-1.5 mt-7 max-w-md mx-auto text-left">
        {['Cada pedido pago genera su guía en DAC.', 'La etiqueta queda lista para imprimir en Etiquetas.', 'Si algo falla, lo ves en el Dashboard con el motivo.'].map((t) => (
          <li key={t} className="flex items-start gap-2.5 text-sm text-zinc-300">
            <div className="w-5 h-5 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Check className="w-3 h-3 text-emerald-400" />
            </div>
            <span>{t}</span>
          </li>
        ))}
      </ul>

      <button type="button" onClick={onBack} className="block w-full text-xs text-zinc-600 hover:text-zinc-400 transition-colors mt-6">
        Volver al paso anterior
      </button>
    </StepCard>
  );
}

function Resumen({ icon: Icon, label, value }: { icon: typeof Check; label: string; value: string }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.06]">
      <Icon className="w-4 h-4 text-cyan-400 flex-shrink-0" />
      <span className="text-xs text-zinc-500 w-14 flex-shrink-0">{label}</span>
      <span className="text-sm text-zinc-200 truncate">{value}</span>
    </li>
  );
}
