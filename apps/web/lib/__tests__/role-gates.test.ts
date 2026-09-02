import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Gates por rol (D32): las páginas que el usuario normal no ve en el menú
 * devuelven 404 server-side desde su layout. Ocultar el link no alcanza.
 */
const mocks = vi.hoisted(() => ({ requireAdminOrNotFound: vi.fn() }));
vi.mock('@/lib/admin', () => ({ requireAdminOrNotFound: mocks.requireAdminOrNotFound }));

import ControlLayout from '@/app/(dashboard)/control/layout';
import OrdersLayout from '@/app/(dashboard)/orders/layout';
import ReportsLayout from '@/app/(dashboard)/reports/layout';
import AdminLayout from '@/app/(dashboard)/admin/layout';

const layouts = [
  ['/control', ControlLayout],
  ['/orders', OrdersLayout],
  ['/reports', ReportsLayout],
  ['/admin', AdminLayout],
] as const;

beforeEach(() => vi.clearAllMocks());

describe.each(layouts)('layout de %s', (_ruta, Layout) => {
  it('no-admin → propaga el 404 y NO renderiza los hijos', async () => {
    mocks.requireAdminOrNotFound.mockRejectedValue(new Error('NEXT_NOT_FOUND'));
    await expect(Layout({ children: 'SECRETO' })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.requireAdminOrNotFound).toHaveBeenCalledTimes(1);
  });

  it('admin → renderiza los hijos tal cual', async () => {
    mocks.requireAdminOrNotFound.mockResolvedValue({ userId: 'u1', email: 'admin@x.com' });
    await expect(Layout({ children: 'CONTENIDO' })).resolves.toBe('CONTENIDO');
  });
});
