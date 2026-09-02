import { redirect } from 'next/navigation';
import { getAuthenticatedTenant } from '@/lib/api-utils';
import { db } from '@/lib/db';

/**
 * Layout server-side de /onboarding.
 *
 * Exige sesión (D33): el wizard es obligatorio y arranca leyendo el tenant
 * en el server (`page.tsx`), así que sin sesión no hay nada que mostrar.
 * `/onboarding` sigue en `publicPaths` del middleware para no duplicar el
 * redirect; el gate real es este. Quien llega sin sesión (los links del
 * tutorial público, por ejemplo) pasa por /login y vuelve acá.
 *
 * Además aplica el gate de email verificado cuando
 * `EMAIL_VERIFICATION_REQUIRED` está prendido, igual que el layout del
 * dashboard, para que nadie cargue tokens sin haber confirmado el mail.
 */
export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuthenticatedTenant();
  if (!auth) redirect('/login?callbackUrl=%2Fonboarding');

  const verifyRequired =
    process.env.EMAIL_VERIFICATION_REQUIRED === '1' ||
    process.env.EMAIL_VERIFICATION_REQUIRED === 'true';

  // Gate apagado: sin lectura extra de la base.
  if (!verifyRequired) return <>{children}</>;

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { email: true, emailVerified: true },
  });

  if (user && !user.emailVerified) {
    redirect(`/verify-email?email=${encodeURIComponent(user.email)}`);
  }

  return <>{children}</>;
}
