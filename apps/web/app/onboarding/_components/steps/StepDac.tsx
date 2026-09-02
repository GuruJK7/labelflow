'use client';

import { useState, type FormEvent } from 'react';
import { Truck, ExternalLink } from 'lucide-react';
import type { OnboardingState } from '@/lib/onboarding-state';
import { DacTutorial } from '../DacTutorial';
import { StepCard, StepHeader, PrimaryButton, SecondaryButton, Notice, DoneCard, StepFooter, inputClass, labelClass } from '../wizard-ui';

/**
 * Paso 3 — Tu cuenta de DAC. Guarda con `POST /api/v1/onboarding/test-dac`
 * (formato + cifrado + borra las cookies de sesión viejas). No hay prueba en
 * vivo contra DAC (H5): el copy lo dice en vez de prometer una verificación
 * que no existe.
 */
export function StepDac({
  state,
  onSaved,
  onFailed,
  onContinue,
  onBack,
}: {
  state: OnboardingState;
  onSaved: () => Promise<void>;
  onFailed: (code: string | number) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const connected = state.dac.connected;
  const [editing, setEditing] = useState(!connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    setOk(false);
    if (!username.trim() || !password) {
      setError('Completá usuario y contraseña de DAC.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/onboarding/test-dac', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dacUsername: username.trim(), dacPassword: password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onFailed(res.status);
        setError(data.error ?? 'No se pudieron guardar las credenciales');
        return;
      }
      setOk(true);
      setPassword('');
      setEditing(false);
      await onSaved();
    } catch {
      onFailed('network');
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard>
      <StepHeader
        icon={Truck}
        title="Tu cuenta de DAC"
        estimate="1 min"
        text={
          <>
            Con estos datos el automatizador entra a{' '}
            <a href="https://www.dac.com.uy" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1">
              dac.com.uy <ExternalLink className="w-3 h-3" />
            </a>{' '}
            y carga cada envío como lo harías vos. Se guardan cifrados.
          </>
        }
      />

      <div className="space-y-3 mb-5">
        {ok && <Notice kind="ok">Cuenta DAC guardada.</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
      </div>

      {connected && !editing ? (
        <DoneCard title="Cuenta DAC guardada" detail={state.dac.username ? `Usuario: ${state.dac.username}` : null} onChange={() => setEditing(true)} />
      ) : (
        <>
          <DacTutorial />
          <form onSubmit={save} className="space-y-4 mt-5">
            <div>
              <label className={labelClass}>Usuario (documento o RUT)</label>
              <input value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} placeholder="Ej: 12345678 o tu RUT" autoComplete="off" maxLength={100} />
              <p className="text-[11px] text-zinc-500 mt-1">Cédula o RUT, igual que en el portal de DAC. No es un email.</p>
            </div>
            <div>
              <label className={labelClass}>Contraseña</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="Tu contraseña de DAC" autoComplete="new-password" maxLength={200} />
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <PrimaryButton type="submit" busy={busy} busyLabel="Guardando…" arrow={false}>
                Guardar
              </PrimaryButton>
              {connected && (
                <button type="button" onClick={() => setEditing(false)} className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2">
                  Dejar la cuenta que ya está guardada
                </button>
              )}
            </div>
          </form>
        </>
      )}

      <div className="mt-5">
      <Notice kind="info">
        No podemos probar el ingreso a DAC desde acá (su portal bloquea pruebas automáticas). Lo confirmamos en tu primer envío: si el usuario o la contraseña están mal, lo vas a ver en el Dashboard con el motivo.
      </Notice>
      </div>

      <StepFooter>
        <SecondaryButton onClick={onBack} back>
          Atrás
        </SecondaryButton>
        <PrimaryButton onClick={onContinue} disabled={!connected}>
          Continuar
        </PrimaryButton>
      </StepFooter>
    </StepCard>
  );
}
