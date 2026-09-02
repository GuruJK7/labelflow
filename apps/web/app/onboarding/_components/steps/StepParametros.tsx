'use client';

import { SlidersHorizontal } from 'lucide-react';
import type { OnboardingState } from '@/lib/onboarding-state';
import { ParametrosForm, AvisoDashboard } from '@/app/(dashboard)/settings/_components/ParametrosForm';
import { StepCard, StepHeader, PrimaryButton, SecondaryButton, StepFooter } from '../wizard-ui';

/**
 * Paso 4 — Parámetros de envío. Es el MISMO componente que Configuración >
 * Parámetros (`ParametrosForm`, en modo compacto: sin el bloque de modo,
 * que es el paso 5). Cada bloque se guarda solo; Continuar no exige guardar.
 *
 * Con Dashboard con Excel no hay nada que ajustar (el job de Dashboard no lee
 * ninguno de estos parámetros): se muestra el aviso y se pasa directo a
 * Continuar, sin pedir los settings.
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
  const esDashboard = state.store.kind === 'dashboard';
  return (
    <StepCard>
      <StepHeader
        icon={SlidersHorizontal}
        title="Cómo querés que se procesen los pedidos"
        estimate={esDashboard ? '10 seg' : '3 min'}
        text={
          esDashboard
            ? 'Con tu forma de conexión no hay parámetros que ajustar. Leé el aviso y seguí.'
            : 'Todo esto tiene un valor por defecto que funciona. Cambiá sólo lo que necesites; podés volver desde Configuración cuando quieras.'
        }
      />

      {esDashboard ? <AvisoDashboard /> : <ParametrosForm compact storeKind={state.store.kind} onSaved={onSaved} />}

      <StepFooter>
        <SecondaryButton onClick={onBack} back>
          Atrás
        </SecondaryButton>
        <PrimaryButton onClick={onContinue}>Continuar</PrimaryButton>
      </StepFooter>
    </StepCard>
  );
}
