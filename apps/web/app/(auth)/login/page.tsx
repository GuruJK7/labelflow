/**
 * Server-component shim for /login. Mirrors /signup — reads the Google
 * OAuth env-var presence at SSR and forwards `googleEnabled` to the
 * client form so the button is rendered only when it actually works.
 */

import { LoginForm } from './LoginForm';

export default function LoginPage() {
  const googleEnabled = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
  );
  return <LoginForm googleEnabled={googleEnabled} />;
}
