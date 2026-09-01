/**
 * Server-component shim for /signup. Espejo de /login: lee la presencia de
 * las env vars de Google OAuth en SSR y le pasa `googleEnabled` al form para
 * que el botón sólo se renderice cuando de verdad funciona.
 *
 * 2026-09-01 (D23): vuelve el alta pública (self-serve). Esta página había
 * quedado como "Acceso por invitación" desde el pivot B2B de mayo 2026; el
 * formulario (`SignupForm`) nunca se borró. El gate real sigue siendo
 * `ALLOW_PUBLIC_SIGNUP` en POST /api/auth/signup (default apagado): con la
 * bandera apagada el form se ve pero el POST devuelve 403 y el usuario lee
 * el mensaje del server.
 *
 * `SignupForm` usa useSearchParams() (?ref=) y ya trae su propio Suspense.
 */

import { SignupForm } from './SignupForm';

export const metadata = {
  title: 'Creá tu cuenta — AutoEnvía',
  description:
    'Creá tu cuenta gratis y conectá tu tienda Shopify con DAC. Sin tarjeta: 10 envíos de regalo para empezar.',
};

/** Alta asistida: mismo número de WhatsApp que usa la landing. */
const WHATSAPP_URL =
  'https://wa.me/59898943949?text=' +
  encodeURIComponent(
    'Hola, quiero que me ayuden a implementar AutoEnvía en mi tienda.',
  );

export default function SignupPage() {
  const googleEnabled = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
  );
  return <SignupForm googleEnabled={googleEnabled} whatsappUrl={WHATSAPP_URL} />;
}
