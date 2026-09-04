'use client';

import { useState, type FormEvent } from 'react';
import { Truck, ExternalLink } from 'lucide-react';
import type { OnboardingState } from '@/lib/onboarding-state';
import { DacTutorial } from '../DacTutorial';
import { StepCard, StepHeader, PrimaryButton, SecondaryButton, Notice, DoneCard, StepFooter, inputClass, labelClass } from '../wizard-ui';

/**
 * Paso 3 — Transportista.
 *
 * Antes era "Tu cuenta de DAC" y no había alternativa: quien elegía Correo
 * Uruguayo no tenía dónde cargarlo y el alta no se podía completar. Ahora el
 * comerciante elige con qué despacha y carga ESA cuenta.
 *
 * Los dos caminos guardan por endpoints distintos porque son cosas distintas:
 *   - DAC   → `POST /api/v1/onboarding/test-dac` (formato + cifrado + limpia
 *             las cookies de sesión viejas). No hay prueba en vivo: el portal
 *             de DAC bloquea pruebas automáticas y el copy lo dice.
 *   - Correo → `PUT /api/v1/settings`, el mismo que usa Configuración. Ese
 *             endpoint EXIGE peso por defecto para poder prender el
 *             transportista, porque Correo rechaza todo envío sin peso y la
 *             tienda quedaría sin despachar nada sin entender por qué.
 */
type Carrier = 'DAC' | 'CORREO';

export function StepTransportista({
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
  const connected = state.transportista.conectado;
  const [carrier, setCarrier] = useState<Carrier>(state.transportista.cual === 'CORREO' ? 'CORREO' : 'DAC');
  const [editing, setEditing] = useState(!connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [cuenta, setCuenta] = useState('');
  const [peso, setPeso] = useState('');
  const [ambiente, setAmbiente] = useState<'test' | 'prod'>('test');

  async function guardarDac(e: FormEvent) {
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

  async function guardarCorreo(e: FormEvent) {
    e.preventDefault();
    setError('');
    setOk(false);
    if (!username.trim() || !password) {
      setError('Completá usuario y contraseña de AhíVA.');
      return;
    }
    const pesoNum = Number(peso.replace(',', '.'));
    if (!Number.isFinite(pesoNum) || pesoNum <= 0 || pesoNum >= 30) {
      setError('Cargá un peso por defecto en kg (mayor a 0 y menor a 30). Correo lo exige en cada envío.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correoEnabled: true,
          correoUser: username.trim(),
          correoPassword: password,
          correoCuenta: cuenta.trim() || null,
          correoAmbiente: ambiente,
          pesoDefaultKg: pesoNum,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onFailed(res.status);
        setError(data.error ?? 'No se pudieron guardar las credenciales de Correo Uruguayo');
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

  const esCorreo = carrier === 'CORREO';

  return (
    <StepCard>
      <StepHeader
        icon={Truck}
        title="Tu transportista"
        estimate="1 min"
        text="Elegí por qué empresa salen tus envíos y cargá esa cuenta. Podés cambiarlo después desde Configuración. Las credenciales se guardan cifradas."
      />

      <div className="space-y-3 mb-5">
        {ok && <Notice kind="ok">{esCorreo ? 'Cuenta de Correo Uruguayo guardada.' : 'Cuenta DAC guardada.'}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
      </div>

      {connected && !editing ? (
        <DoneCard
          title={state.transportista.cual === 'CORREO' ? 'Correo Uruguayo conectado' : 'Cuenta DAC guardada'}
          detail={
            state.transportista.cual === 'CORREO'
              ? state.transportista.correoUser
                ? `Usuario: ${state.transportista.correoUser}`
                : null
              : state.transportista.dacUsername
                ? `Usuario: ${state.transportista.dacUsername}`
                : null
          }
          onChange={() => setEditing(true)}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            {(
              [
                { id: 'DAC' as const, nombre: 'DAC', detalle: 'Entrega a domicilio en todo el país. Es el que usa la mayoría.' },
                { id: 'CORREO' as const, nombre: 'Correo Uruguayo', detalle: 'Entrega en agencia: el cliente retira. Admite cobrar al entregar.' },
              ]
            ).map((op) => (
              <button
                key={op.id}
                type="button"
                onClick={() => { setCarrier(op.id); setError(''); }}
                className={`text-left rounded-xl border p-4 transition ${
                  carrier === op.id
                    ? 'border-cyan-500/60 bg-cyan-500/5'
                    : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                }`}
              >
                <span className="block text-sm font-medium text-zinc-100">{op.nombre}</span>
                <span className="block text-[11px] text-zinc-500 mt-1 leading-relaxed">{op.detalle}</span>
              </button>
            ))}
          </div>

          {esCorreo ? (
            <form onSubmit={guardarCorreo} className="space-y-4">
              <div>
                <label className={labelClass}>Usuario de AhíVA</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} placeholder="Tu cédula o RUT, igual que en el portal" autoComplete="off" maxLength={120} />
                <p className="text-[11px] text-zinc-500 mt-1">
                  El mismo con el que entrás a{' '}
                  <a href="https://ahiva.correo.com.uy" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1">
                    ahiva.correo.com.uy <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              </div>
              <div>
                <label className={labelClass}>Contraseña</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="Tu contraseña de AhíVA" autoComplete="new-password" maxLength={200} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Nº de cuenta (opcional)</label>
                  <input value={cuenta} onChange={(e) => setCuenta(e.target.value)} className={inputClass} placeholder="Si Correo te dio uno" autoComplete="off" maxLength={60} />
                </div>
                <div>
                  <label className={labelClass}>Peso por defecto (kg)</label>
                  <input value={peso} onChange={(e) => setPeso(e.target.value)} className={inputClass} placeholder="Ej: 0.5" inputMode="decimal" maxLength={6} />
                  <p className="text-[11px] text-zinc-500 mt-1">Correo exige el peso en cada envío. Se usa cuando el pedido no trae el suyo.</p>
                </div>
              </div>
              <div>
                <label className={labelClass}>Ambiente</label>
                <select value={ambiente} onChange={(e) => setAmbiente(e.target.value === 'prod' ? 'prod' : 'test')} className={inputClass}>
                  <option value="test">Prueba — no emite guías reales</option>
                  <option value="prod">Producción — emite guías reales</option>
                </select>
                <p className="text-[11px] text-zinc-500 mt-1">Empezá en Prueba. En ese modo no se despacha nada ni se toca tu tienda.</p>
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
          ) : (
            <>
              <DacTutorial />
              <form onSubmit={guardarDac} className="space-y-4 mt-5">
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
        </>
      )}

      <div className="mt-5">
        <Notice kind="info">
          {esCorreo
            ? 'La agencia a la que Correo devuelve los paquetes que no se pueden entregar se carga después, en Configuración → Transportista: ahí se valida contra el catálogo real de sucursales.'
            : 'No podemos probar el ingreso a DAC desde acá (su portal bloquea pruebas automáticas). Lo confirmamos en tu primer envío: si el usuario o la contraseña están mal, lo vas a ver en el Dashboard con el motivo.'}
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
