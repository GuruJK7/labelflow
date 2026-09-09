import { requireAdminOrNotFound } from '@/lib/admin';

/**
 * El resumen del depósito cruza tiendas de distintos dueños, así que es una
 * vista de operador. Igual que /admin y /ads: esconder el link del menú NO es
 * el control de acceso — la puerta está acá, server-side, y devuelve 404.
 */
export default async function DepositoLayout({ children }: { children: React.ReactNode }) {
  await requireAdminOrNotFound();
  return <>{children}</>;
}
