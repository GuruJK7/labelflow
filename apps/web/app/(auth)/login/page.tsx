/**
 * Server-component shim for /login. Mirrors /signup — reads the Google
 * OAuth env-var presence at SSR and forwards `googleEnabled` to the
 * client form so the button is rendered only when it actually works.
 *
 * 2026-05-15: LoginForm uses useSearchParams() to detect ?reset=ok and
 * show the password-reset success banner. Next.js requires that any
 * component using useSearchParams() be wrapped in a Suspense boundary
 * during static generation — without this wrapper, `next build` fails
 * with "useSearchParams() should be wrapped in a suspense boundary".
 * The fallback is the bare form without the banner; the real form
 * mounts within the Suspense once the URL is known on the client.
 */

import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export default function LoginPage() {
  const googleEnabled = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
  );
  return (
    <Suspense fallback={null}>
      <LoginForm googleEnabled={googleEnabled} />
    </Suspense>
  );
}
