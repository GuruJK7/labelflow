import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Registro del acceso de un OPERADOR a datos personales de un cliente.
 *
 * 🔴 QUÉ ARREGLA. Shopify pregunta, en la solicitud de acceso a datos
 * protegidos, «¿Registrás el acceso a los datos personales?». La respuesta
 * honesta era NO: `AuditLog` existía y su docblock mencionaba
 * `admin.tenant.impersonate` como ejemplo, pero nadie lo escribía nunca — lo
 * único registrado eran logins y cambios de contraseña. Un admin podía abrir
 * Control y leer nombres, teléfonos y direcciones de los clientes de cualquier
 * comerciante sin dejar rastro.
 */
const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), writeAuditLog: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { tenant: { findFirst: mocks.findFirst }, user: { findUnique: vi.fn() } } }));
vi.mock('@/lib/audit-log', () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock('@/lib/api-utils', () => ({ getAuthenticatedUser: vi.fn() }));
vi.mock('@/lib/admin', () => ({ isAdminEmail: vi.fn() }));

import { auditControlAccess } from '@/lib/control-scope';

beforeEach(() => {
  mocks.findFirst.mockReset();
  mocks.writeAuditLog.mockReset();
});

describe('auditoría de acceso de operador', () => {
  it('registra cuando un admin mira un tenant AJENO', async () => {
    mocks.findFirst.mockResolvedValue(null); // no es suyo
    await auditControlAccess({ userId: 'u_admin', isAdmin: true }, 't_ajeno', 'control.labels.read');
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'control.labels.read',
        userId: 'u_admin',
        tenantId: 't_ajeno',
        entityType: 'Tenant',
      }),
    );
  });

  it('NO registra al admin mirando lo suyo: sería ruido que vuelve inútil el log', async () => {
    mocks.findFirst.mockResolvedValue({ id: 't_propio' });
    await auditControlAccess({ userId: 'u_admin', isAdmin: true }, 't_propio', 'control.labels.read');
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('NO registra al comerciante mirando sus propios envíos', async () => {
    await auditControlAccess({ userId: 'u1', isAdmin: false }, 't1', 'control.labels.read');
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('si la auditoría falla, la operación del operador NO se cae', async () => {
    mocks.findFirst.mockRejectedValue(new Error('base caída'));
    await expect(
      auditControlAccess({ userId: 'u_admin', isAdmin: true }, 't_ajeno', 'control.run.run'),
    ).resolves.toBeUndefined();
  });
});

describe('las rutas de Control lo llaman', () => {
  it('las que leen o accionan datos de un cliente registran el acceso', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const base = join(__dirname, '..', '..', 'app', 'api', 'v1', 'control');
    for (const ruta of ['labels', 'retry', 'run']) {
      const src = readFileSync(join(base, ruta, 'route.ts'), 'utf8');
      expect(src, `${ruta} no registra el acceso`).toContain('auditControlAccess(actor, tenantId');
    }
  });
});
