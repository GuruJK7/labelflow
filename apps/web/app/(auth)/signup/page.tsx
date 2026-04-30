/**
 * Server-component shim for /signup. Reads the Google OAuth env-var
 * presence on the server and forwards a `googleEnabled` flag to the
 * client form. Without this flag the client would unconditionally
 * render the Google button — and clicking it when the provider isn't
 * actually loaded by NextAuth bounces the user to /login (the
 * `pages.signIn` fallback in authOptions). That's a confusing UX
 * regression for first-time visitors, so we hide the button on the
 * server before any HTML is sent.
 */

import { SignupForm } from './SignupForm';

export default function SignupPage() {
  const googleEnabled = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
  );
  return <SignupForm googleEnabled={googleEnabled} />;
}
