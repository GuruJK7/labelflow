'use client';

import { useEffect, useRef, useState } from 'react';

interface CounterProps {
  /** Target numeric value (e.g. 99.5 for "99.5%") */
  value: number;
  /** Decimal places to render — defaults to inferring from `value`. */
  decimals?: number;
  /** Optional prefix (e.g. "$") */
  prefix?: string;
  /** Optional suffix (e.g. "%", "+") */
  suffix?: string;
  /** Animation duration in ms. Defaults 1600. */
  duration?: number;
  /** Locale for number formatting. Defaults es-UY. */
  locale?: string;
  className?: string;
}

/**
 * Animated counter that ramps from 0 to `value` when scrolled into view.
 * SSR renders the final value directly so non-JS clients see correct text;
 * on hydration we reset to 0 and animate up using requestAnimationFrame.
 *
 * Uses easeOutCubic for a satisfying deceleration — better feel than linear.
 */
export function Counter({
  value,
  decimals,
  prefix = '',
  suffix = '',
  duration = 1600,
  locale = 'es-UY',
  className = '',
}: CounterProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(value);
  const startedRef = useRef(false);

  const fractionDigits =
    decimals ?? (Number.isInteger(value) ? 0 : (value.toString().split('.')[1]?.length ?? 1));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const run = () => {
      if (startedRef.current) return;
      startedRef.current = true;

      // Reset to 0 RIGHT BEFORE the animation starts (not on mount). This
      // keeps the SSR-rendered final value visible until the counter is
      // actually about to animate — avoids a flicker where above-the-fold
      // counters showed "99,5" → "0" → animate while hydrating.
      setDisplay(0);

      const start = performance.now();
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

      const tick = (now: number) => {
        const elapsed = now - start;
        const t = Math.min(1, elapsed / duration);
        const eased = easeOutCubic(t);
        setDisplay(value * eased);
        if (t < 1) requestAnimationFrame(tick);
        else setDisplay(value);
      };

      requestAnimationFrame(tick);
    };

    if (typeof IntersectionObserver === 'undefined') {
      run();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            run();
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.5 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [value, duration]);

  const formatted = display.toLocaleString(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

  return (
    <span ref={ref} className={`tabular ${className}`}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
