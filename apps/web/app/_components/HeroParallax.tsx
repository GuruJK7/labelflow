'use client';

import { useEffect, useRef, type CSSProperties } from 'react';

/**
 * Floating "live data" chips + DAC labels behind the hero, with subtle scroll
 * + mouse parallax (ported from the autoenvia-landing demo). Decorative only:
 * pointer-events-none, aria-hidden, and fully disabled under reduced-motion.
 */

type Chip = { cls: 'ok' | 'cy' | 'mu'; plx: number; style: CSSProperties; text: string; hidem?: boolean };
type Lbl = { plx: number; style: CSSProperties; hidem?: boolean };

const CHIPS: Chip[] = [
  { cls: 'ok', plx: 0.16, style: { top: '24%', left: '9%' }, text: '#5736 · guía emitida · 0.4s' },
  { cls: 'cy', plx: 0.26, style: { top: '62%', left: '6%' }, text: 'DAC 8821249082950', hidem: true },
  { cls: 'mu', plx: 0.1, style: { top: '30%', right: '7%' }, text: '03:12 a.m. · procesando', hidem: true },
  { cls: 'ok', plx: 0.3, style: { top: '68%', right: '9%' }, text: '56 etiquetas · 1 clic' },
];
const LABELS: Lbl[] = [
  { plx: 0.2, style: { top: '46%', left: '13%' }, hidem: true },
  { plx: 0.14, style: { top: '50%', right: '14%' } },
];

export function HeroParallax() {
  const layerRef = useRef<HTMLDivElement>(null);
  const elsRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const els = elsRef.current;
    let ticking = false;
    const frame = () => {
      ticking = false;
      const vh = window.innerHeight;
      for (const el of els) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < -200 || r.top > vh + 200) continue;
        const center = r.top + r.height / 2 - vh / 2;
        el.style.transform = `translate3d(0, ${(center * parseFloat(el.dataset.plx || '0')).toFixed(1)}px, 0)`;
      }
    };
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(frame);
        ticking = true;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    frame();

    let onMove: ((e: MouseEvent) => void) | null = null;
    if (window.matchMedia('(pointer:fine)').matches && layerRef.current) {
      const layer = layerRef.current;
      onMove = (e: MouseEvent) => {
        const x = e.clientX / window.innerWidth - 0.5;
        const y = e.clientY / window.innerHeight - 0.5;
        layer.style.transform = `translate3d(${(x * 18).toFixed(1)}px, ${(y * 12).toFixed(1)}px, 0)`;
      };
      window.addEventListener('mousemove', onMove, { passive: true });
    }

    return () => {
      window.removeEventListener('scroll', onScroll);
      if (onMove) window.removeEventListener('mousemove', onMove);
    };
  }, []);

  const collect = (el: HTMLElement | null) => {
    if (el && !elsRef.current.includes(el)) elsRef.current.push(el);
  };

  return (
    <div ref={layerRef} aria-hidden className="hero-float">
      {CHIPS.map((c, i) => (
        <div
          key={`c${i}`}
          ref={collect}
          data-plx={c.plx}
          style={c.style}
          className={`fchip ${c.cls}${c.hidem ? ' hidem' : ''}`}
        >
          <i />
          {c.text}
        </div>
      ))}
      {LABELS.map((l, i) => (
        <div
          key={`l${i}`}
          ref={collect}
          data-plx={l.plx}
          style={l.style}
          className={`flbl${l.hidem ? ' hidem' : ''}`}
        >
          <span className="strip" />
          <span className="bars" />
          <small>DAC</small>
        </div>
      ))}
    </div>
  );
}
