import { getServerSession } from 'next-auth';
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

  const email = user.email.toLowerCase();
  const allowed = getAdminEmails();
  if (allowed.size === 0) return null; // No admin configured → block.
  if (!allowed.has(email)) return null;

  return { userId, email };
}
