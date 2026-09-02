import { redirect } from 'next/navigation';
import { getAuthenticatedTenant } from '@/lib/api-utils';
import { loadOnboardingState } from '@/lib/onboarding-state.server';
import { parseRequestedStep } from '@/lib/onboarding-state';
import { OnboardingWizard } from './_components/OnboardingWizard';

export const dynamic = 'force-dynamic';

/**
 * /onboarding — server component (D33).
 *
 * Lee el estado derivado de la base y se lo pasa al wizard ya resuelto: el
 * usuario aterriza en el paso que le falta, no en el primero. Si ya completó
 * y no pidió un paso concreto, va al dashboard; con `?step=N` (los links de
 * Configuración) puede volver a cualquier paso para editarlo.
 *
 * `?shopify=…` (retorno del OAuth) no se toca acá: lo lee el wizard en el
 * cliente y limpia la URL.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams?: { step?: string | string[] };
}) {
  const auth = await getAuthenticatedTenant();
  if (!auth) redirect('/login?callbackUrl=%2Fonboarding');

  const state = await loadOnboardingState(auth.tenantId);
  if (!state) redirect('/login');

  const requested = parseRequestedStep(searchParams?.step);
  if (state.onboardingComplete && !requested) redirect('/dashboard');

  return <OnboardingWizard initial={state} requestedStep={requested} />;
}
