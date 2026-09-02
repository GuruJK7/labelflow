'use client';

import { SlidersHorizontal } from 'lucide-react';
import type { OnboardingState } from '@/lib/onboarding-state';
import { ParametrosForm } from '@/app/(dashboard)/settings/_components/ParametrosForm';
import { StepCard, StepHeader, PrimaryButton, SecondaryButton, StepFooter } from '../wizard-ui';

/**
 * Paso 4 — Parámetros de envío. Es el MISMO componente que Configuración >
 * Parámetros (`ParametrosForm`, en modo compacto: sin el bloque de modo,
 * que es el paso 5). Cada bloque se guarda solo; Continuar no exige guardar.
 */
export function StepParametros({
  state,
  onSaved,
  onContinue,
  onBack,
}: {
  state: OnboardingState;
  onSaved: (block: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <StepCard>
      <StepHeader
        icon={SlidersHorizontal}
        title="Cómo querés que se procesen los pedidos"
        estimate="3 min"
        text="Todo esto tiene un valor por defecto que funciona. Cambiá sólo lo que necesites; podés volver desde Configuración cuando quieras."
      />

      <ParametrosForm compact storeKind={state.store.kind} onSaved={onSaved} />

      <StepFooter>
        <SecondaryButton onClick={onBack} back>
          Atrás
        </SecondaryButton>
        <PrimaryButton onClick={onContinue}>Continuar</PrimaryButton>
      </StepFooter>
    </StepCard>
  );
}
