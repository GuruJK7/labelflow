'use client';

/**
 * Aggregates all client providers into a single component imported once
 * by the root layout. Order matters:
 *
 *   <SessionProvider>      ← NextAuth context (must wrap useSession callers)
 *     <PostHogProvider>    ← initializes PostHog client
 *       <PostHogPageview/> ← captures $pageview on route change
 *       <IdentifyOnAuth/>  ← runs posthog.identify(tenantId) post-login
 *       {children}
 *     </PostHogProvider>
 *   </SessionProvider>
 */

import { Suspense } from 'react';
import { SessionProvider } from './SessionProvider';
import { PostHogProvider, PostHogPageview } from './PostHogProvider';
import { IdentifyOnAuth } from './IdentifyOnAuth';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <PostHogProvider>
        <Suspense fallback={null}>
          <PostHogPageview />
        </Suspense>
        <IdentifyOnAuth />
        {children}
      </PostHogProvider>
    </SessionProvider>
  );
}
