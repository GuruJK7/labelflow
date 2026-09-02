import { requireAdminOrNotFound } from '@/lib/admin';

/**
 * Server-side gate for /admin/*. Non-admins (and unauthenticated requests)
 * get a 404 — we don't want to reveal the route's existence to non-admins,
 * and unauthenticated users get the same response as anyone else who
 * doesn't pass the gate. They can still navigate to /login from anywhere
 * else in the app if they need to sign in.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminOrNotFound();
  return children;
}
