'use client';

/**
 * Thin client wrapper around NextAuth's SessionProvider so `useSession()`
 * works in client components (e.g. IdentifyOnAuth). NextAuth v4 requires
 * this provider to be mounted somewhere in the tree above any consumer.
 */

import { SessionProvider as NextAuthSessionProvider } from 'next-auth/react';

export function SessionProvider({ children }: { children: React.ReactNode }) {
  return <NextAuthSessionProvider>{children}</NextAuthSessionProvider>;
}
