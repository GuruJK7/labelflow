import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from './auth';

interface SessionWithTenant {
  userId: string;
  tenantId: string;
  isActive: boolean;
  subscriptionStatus: string;
}

/**
 * Gets authenticated session with tenant info.
 * Returns null if not authenticated.
 */
export async function getAuthenticatedTenant(): Promise<SessionWithTenant | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;

  const user = session.user as Record<string, unknown>;
  const tenantId = user.tenantId as string | undefined;
  const userId = user.id as string | undefined;

  if (!userId || !tenantId) return null;

  return {
    userId,
    tenantId,
    isActive: (user.isActive as boolean) ?? false,
    subscriptionStatus: (user.subscriptionStatus as string) ?? 'INACTIVE',
  };
}

/**
 * Auth helper for tenant-management endpoints — returns just the userId
 * without requiring an active tenantId in the session. Used for endpoints
 * like POST /api/v1/tenants (create new store) where the user might not
 * have any tenant yet, OR /api/v1/tenants/switch where they're choosing
 * a different tenant than the current session one.
 *
 * For per-tenant endpoints (most of /api/v1) keep using
 * getAuthenticatedTenant() — it enforces the tenantId is set.
 */
export async function getAuthenticatedUser(): Promise<{ userId: string } | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const userId = (session.user as Record<string, unknown>).id as string | undefined;
  if (!userId) return null;
  return { userId };
}

/**
 * Standard API error response.
 */
export function apiError(message: string, status: number = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Standard API success response.
 */
export function apiSuccess<T>(data: T, meta?: Record<string, unknown>) {
  return NextResponse.json({ data, meta });
}
