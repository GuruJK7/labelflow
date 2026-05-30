'use client';

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';

type Variant = 'up' | 'left' | 'right' | 'scale';

interface ScrollRevealProps {
  children: ReactNode;
  variant?: Variant;
  stagger?: boolean;
  delay?: number;
  threshold?: number;
  rootMargin?: string;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  style?: CSSProperties;
}

/**
 * Wrap any subtree in <ScrollReveal> to fade + slide it in the first time
 * it enters the viewport. Animations live in globals.css (.reveal class) —
 * this component only flips the data-visible attribute.
 *
 * - `variant`: which transform to animate from. Defaults to 'up'.
 * - `stagger`: adds the .reveal-stagger parent class. Children inside need
 *   the .reveal-item class to participate.
 * - `delay`: ms before the entry animation kicks in (good for layered hero).
 * - `threshold` / `rootMargin`: standard IntersectionObserver tuning.
 *
 * SSR-safe: renders the element with the initial (invisible) styles on the
 * server, then the effect runs on the client to observe + reveal. If JS is
 * disabled or IntersectionObserver is unavailable, we reveal immediately.
 */
export function ScrollReveal({
  children,
  variant = 'up',
  stagger = false,
  delay = 0,
  threshold = 0.15,
  rootMargin = '0px 0px -80px 0px',
  as: Tag = 'div',
  className = '',
  style,
}: ScrollRevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  const variantClass =
    variant === 'left' ? 'reveal-left' :
    variant === 'right' ? 'reveal-right' :
    variant === 'scale' ? 'reveal-scale' : '';

  const composed = [
    'reveal',
    variantClass,
    stagger ? 'reveal-stagger' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const mergedStyle: CSSProperties = {
    ...style,
    transitionDelay: delay ? `${delay}ms` : undefined,
  };

  const Component = Tag as unknown as React.ElementType;
  return (
    <Component
      ref={ref as React.Ref<HTMLElement>}
      data-visible={visible ? 'true' : 'false'}
      className={composed}
      style={mergedStyle}
    >
      {children}
    </Component>
  );
}
