'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Vertical progress line for the implementation timeline — a faint track with a
 * cyan→emerald fill that "draws" itself from the top as the section scrolls
 * through the viewport. Place inside the timeline's `relative` container.
 * Decorative; under reduced-motion it renders fully drawn.
 */
export function TimelineFill() {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setProgress(1);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const r = el.getBoundingClientRect();
      const p = (window.innerHeight * 0.75 - r.top) / r.height;
      setProgress(Math.max(0, Math.min(1, p)));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="absolute left-[18px] md:left-1/2 md:-translate-x-1/2 top-0 bottom-0 w-px overflow-hidden"
    >
      <div className="absolute inset-0 bg-white/[0.06]" />
      <div
        className="absolute inset-x-0 top-0 h-full origin-top bg-gradient-to-b from-cyan-400 to-emerald-400 shadow-[0_0_12px_-2px_rgba(34,211,238,0.5)]"
        style={{ transform: `scaleY(${progress})`, transition: 'transform 120ms linear' }}
      />
    </div>
  );
}
