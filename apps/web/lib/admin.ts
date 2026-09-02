import { getServerSession } from 'next-auth';
import { notFound } from 'next/navigation';
import { authOptions } from './auth';
import { db } from './db';

/**
 * Whitelist of email addresses with admin access. Set via env:
 *   ADMIN_EMAILS=adrijk7.cr@gmail.com,otro@example.com
 *
 * Falls back to a single ADMIN_EMAIL for the common one-owner case.
 *
 * Why env-driven instead of a `User.role` column? It's reversible without a
 * migration, can't be escalated by a compromised tenant DB write, and we
 * only have one operator today. If the team grows we can promote to a real
 * column without churn since the helper is the only call site.
 */
function getAdminEmails(): Set<string> {
  const list = process.env.ADMIN_EMAILS ?? process.env.ADMIN_EMAIL ?? '';
  return new Set(
    list
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * ¿Este email es admin? Puro (sin sesión ni base): lo usa el layout del
 * dashboard, que ya trae `tenant.user.email`, para decidir el menú por rol
 * (D32) sin una query extra. Lista vacía = nadie es admin. Insensible a
 * mayúsculas y espacios en los bordes.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = getAdminEmails();
  if (allowed.size === 0) return false;
  return allowed.has(email.trim().toLowerCase());
}

export interface AdminSession {
  userId: string;
  email: string;
}

/**
 * Validates that the current session belongs to a whitelisted admin email.
 * Returns null otherwise — caller should respond 403/404 (we use 404 to
 * avoid leaking the existence of admin endpoints).
 *
 * Looks up the email from the User row (not the session token) so a stale
 * JWT can't grant access if the email changes — and so OAuth-only logins
 * that don't put email in the token still work.
 */
export async function getAdminSession(): Promise<AdminSession | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;

  const userId = (session.user as Record<string, unknown>).id as string | undefined;
  if (!userId) return null;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user?.email) return null;
  if (!isAdminEmail(user.email)) return null;

  return { userId, email: user.email.toLowerCase() };
}

/**
 * Gate server-side para páginas sólo-admin (D32): Control, Pedidos, Reportes,
 * Meta Ads, Recover y /admin. Un usuario normal recibe 404 — no se le revela
 * que la ruta existe — aunque escriba la URL a mano: ocultar el link del menú
 * no alcanza. Mismo criterio que tenía /admin.
 */
export async function requireAdminOrNotFound(): Promise<AdminSession> {
  const admin = await getAdminSession();
  if (!admin) notFound();
  return admin;
}
