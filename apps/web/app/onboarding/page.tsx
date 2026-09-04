import { redirect } from 'next/navigation';
import { getAuthenticatedTenant } from '@/lib/api-utils';
import { loadOnboardingState } from '@/lib/onboarding-state.server';
import { parseRequestedStep, shouldRedirectToDashboard } from '@/lib/onboarding-state';
import { OnboardingWizard } from './_components/OnboardingWizard';

export const dynamic = 'force-dynamic';

/**
 * /onboarding — server component (D33).
 *
 * Lee el estado derivado de la base y se lo pasa al wizard ya resuelto: el
 * usuario aterriza en el paso que le falta, no en el primero. Si ya completó
 * Y sigue conectado, y no pidió un paso concreto, va al dashboard; con
 * `?step=N` (los links de Configuración) puede volver a cualquier paso.
 *
 * Un tenant completo que perdió la tienda o DAC (desinstaló la app desde
 * Shopify, borró un token) NO se redirige: el layout del dashboard lo manda
 * acá y, si esta página lo devolviera, el navegador cortaría con
 * ERR_TOO_MANY_REDIRECTS y no podría entrar a ninguna pantalla.
 *
 * `?shopify=…` (retorno del OAuth) tampoco redirige, para que el que
 * reconecta desde Configuración vea el resultado; el valor lo lee el wizard
 * en el cliente y limpia la URL.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams?: { step?: string | string[]; shopify?: string | string[] };
}) {
  const auth = await getAuthenticatedTenant();
  if (!auth) redirect('/login?callbackUrl=%2Fonboarding');

  const state = await loadOnboardingState(auth.tenantId);
  if (!state) redirect('/login');

  const requested = parseRequestedStep(searchParams?.step);
  const shopifyReturn = !!(Array.isArray(searchParams?.shopify) ? searchParams?.shopify[0] : searchParams?.shopify);
  if (shouldRedirectToDashboard(state, { requestedStep: requested, shopifyReturn })) redirect('/dashboard');

  return <OnboardingWizard initial={state} requestedStep={requested} tenantIdActual={auth.tenantId} />;
}
