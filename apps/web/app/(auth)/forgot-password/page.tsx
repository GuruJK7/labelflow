/**
 * /forgot-password — request a password-reset email.
 *
 * UX intentionally bland: regardless of whether the email matches a real
 * user, the success screen says "if your email is registered, we sent a
 * link". This keeps the page from becoming a user-enumeration oracle —
 * see /api/auth/password-reset/request for the API-level guard.
 *
 * The form posts JSON to the request route, which fires the email
 * asynchronously and immediately returns 200. The user always reaches
 * the same "check your inbox" screen.
 */
import { ForgotPasswordForm } from './ForgotPasswordForm';

export const metadata = {
  title: 'Recuperar contraseña — LabelFlow',
  description: 'Restablecé tu contraseña de LabelFlow para volver al panel.',
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
