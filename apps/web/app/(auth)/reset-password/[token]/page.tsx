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
  title: 'Elegir nueva contraseña — AutoEnvía',
};

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ResetPasswordPage({ params, searchParams }: Props) {
  const { token } = await params;
  // La instalación desde el Shopify App Store trae al comerciante DIRECTO acá
  // (callback → /reset-password/<token>?shopify=welcome|reconnected): para él
  // no es "restablecer" nada, es elegir la primera contraseña de una cuenta
  // que se creó sola. La pantalla tiene que decírselo.
  const motivo = (await searchParams).shopify;
  const bienvenida = motivo === 'welcome' || motivo === 'reconnected' ? motivo : null;
  return <ResetPasswordForm token={token} bienvenida={bienvenida} />;
}
