'use client';

import { useState } from 'react';
import { Clock } from 'lucide-react';
import type { OnboardingState } from '@/lib/onboarding-state';
import { ModoProcesamiento, saveProcessingMode, type SelectableMode } from '@/app/(dashboard)/settings/_components/ModoProcesamiento';
import { StepCard, StepHeader, PrimaryButton, SecondaryButton, Notice, StepFooter } from '../wizard-ui';

/**
 * Paso 5 — Cada cuánto procesamos tus pedidos. Escribe `cronSchedule` con
 * el mismo control que Configuración > Parámetros > Cómo se procesan.
 */
export function StepModo({
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
  const current = state.processingMode;
  const [choice, setChoice] = useState<SelectableMode | null>(current === 'personalizado' ? null : current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function saveAndContinue() {
    setError('');
    if (!choice) {
      setError('Elegí una de las dos opciones.');
      return;
    }
    if (choice === current) {
      onContinue();
      return;
    }
    setBusy(true);
    const r = await saveProcessingMode(choice);
    setBusy(false);
    if (!r.ok) {
      onFailed('settings');
      setError(r.error ?? 'No se pudo guardar el modo');
      return;
    }
    await onSaved();
    onContinue();
  }

  return (
    <StepCard>
      <StepHeader
        icon={Clock}
        title="Cada cuánto procesamos tus pedidos"
        estimate="30 seg"
        text="Podés cambiarlo después desde Configuración."
      />

      {error && (
        <div className="mb-4">
          <Notice kind="error">{error}</Notice>
        </div>
      )}

      <ModoProcesamiento value={choice} currentMode={current} storeKind={state.store.kind} onChange={setChoice} disabled={busy} />

      <StepFooter>
        <SecondaryButton onClick={onBack} back>
          Atrás
        </SecondaryButton>
        <PrimaryButton onClick={saveAndContinue} busy={busy} busyLabel="Guardando…" disabled={!choice}>
          Guardar y continuar
        </PrimaryButton>
      </StepFooter>
    </StepCard>
  );
}
