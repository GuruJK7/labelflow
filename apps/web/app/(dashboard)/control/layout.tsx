import { requireAdminOrNotFound } from '@/lib/admin';

/**
 * Sólo admin (D32). El usuario normal ve Dashboard, Etiquetas y
 * Configuración; esta ruta no está en su menú y, si la escribe a mano,
 * recibe 404 server-side. Ocultar el link no es control de acceso.
 */
export default async function AdminOnlyLayout({ children }: { children: React.ReactNode }) {
  await requireAdminOrNotFound();
  return children;
}
