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
