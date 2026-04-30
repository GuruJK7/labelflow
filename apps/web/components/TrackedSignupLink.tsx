'use client';

/**
 * Wrapper around <Link> that fires a `signup_started` event on click,
 * tagged with the location of the CTA (hero, navbar, pricing, etc.).
 *
 * Why a client component instead of `data-ph-capture` + autocapture:
 *   PostHog's autocapture fires `$autocapture` events with element
 *   metadata, NOT custom-named events. To get `signup_started` (the
 *   funnel step name) we have to call `posthog.capture()` ourselves,
 *   which requires a click handler — hence this wrapper.
 *
 * The wrapped <Link> is unchanged otherwise: client-side navigation,
 * prefetch, etc. all preserved.
 */

import Link, { type LinkProps } from 'next/link';
import { track } from '@/lib/analytics';
import type { ReactNode, MouseEvent } from 'react';

type CtaLocation =
  | 'hero'
  | 'hero_secondary'
  | 'navbar'
  | 'pricing'
  | 'referrals'
  | 'final_cta'
  | 'faq';

type Props = LinkProps & {
  ctaLocation: CtaLocation;
  className?: string;
  children: ReactNode;
};

export function TrackedSignupLink({
  ctaLocation,
  children,
  onClick,
  ...linkProps
}: Props) {
  return (
    <Link
      {...linkProps}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        track('signup_started', { cta_location: ctaLocation });
        onClick?.(e);
      }}
    >
      {children}
    </Link>
  );
}
