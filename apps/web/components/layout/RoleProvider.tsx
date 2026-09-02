'use client';

import { createContext, useContext } from 'react';

/**
 * Rol del usuario logueado, resuelto en el layout del dashboard (server) a
 * partir de ADMIN_EMAILS y bajado a los client components (D32). Default
 * `false`: cualquier componente que se renderice fuera del provider se
 * comporta como usuario normal, nunca como admin.
 *
 * Es sólo para la UI (qué mostrar). El control de acceso real está en el
 * server: requireAdminOrNotFound() en los layouts sólo-admin.
 */
const RoleContext = createContext<boolean>(false);

export function RoleProvider({ isAdmin, children }: { isAdmin: boolean; children: React.ReactNode }) {
  return <RoleContext.Provider value={isAdmin}>{children}</RoleContext.Provider>;
}

export function useIsAdmin(): boolean {
  return useContext(RoleContext);
}
