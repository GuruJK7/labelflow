/**
 * /reset-password/[token] — set a new password using a single-use token.
 *
 * The token comes from the email link. The page itself does NOT validate
 * the token at SSR time — that would burn a DB read per page load and
 * incidentally help attackers probe which tokens are valid. Instead the
 * page just renders the form, and the POST to /api/auth/password-reset/confirm
 * is the only step that hits the DB.
 *
 * On success we redirect to /login with a query param so the login page
 * can show a "tu contraseña fue actualizada, iniciá sesión" banner.
 */
import { ResetPasswordForm } from './ResetPasswordForm';

export const metadata = {
  title: 'Elegir nueva contraseña — LabelFlow',
};

type Props = {
  params: Promise<{ token: string }>;
};

export default async function ResetPasswordPage({ params }: Props) {
  const { token } = await params;
  return <ResetPasswordForm token={token} />;
}
