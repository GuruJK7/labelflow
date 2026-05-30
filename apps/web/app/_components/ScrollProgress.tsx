'use client';

import { useEffect, useState } from 'react';

/**
 * Thin 2px progress bar fixed to the top of the viewport that fills as the
 * user scrolls the page. Uses `scrollYProgress = scrollTop / (scrollHeight - innerHeight)`.
 *
 * Cyan→emerald gradient that matches the rest of the landing palette.
 * Updates via passive scroll listener; the transform is GPU-accelerated.
 */
export function ScrollProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const p = max > 0 ? h.scrollTop / max : 0;
      setProgress(Math.min(1, Math.max(0, p)));
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
      aria-hidden
      className="fixed top-0 left-0 right-0 h-[2px] z-[60] pointer-events-none"
    >
      <div
        className="h-full bg-gradient-to-r from-cyan-400 via-cyan-300 to-emerald-400 shadow-[0_0_10px_rgba(6,182,212,0.6)]"
        style={{
          transform: `scaleX(${progress})`,
          transformOrigin: '0% 50%',
          transition: 'transform 80ms linear',
        }}
      />
    </div>
  );
}
