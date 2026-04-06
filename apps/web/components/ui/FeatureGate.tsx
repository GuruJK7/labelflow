'use client';

import { isFeatureEnabled, type FeatureFlag } from '@/lib/feature-flags';
import { ComingSoon } from './ComingSoon';

interface FeatureGateProps {
  flag: FeatureFlag;
  title: string;
  description?: string;
  children: React.ReactNode;
}

/**
 * Wraps a page/section and shows "Coming Soon" if the feature flag is disabled.
 * Use in page.tsx files to gate entire features.
 */
export function FeatureGate({ flag, title, description, children }: FeatureGateProps) {
  if (!isFeatureEnabled(flag)) {
    return <ComingSoon title={title} description={description} />;
  }
  return <>{children}</>;
}
