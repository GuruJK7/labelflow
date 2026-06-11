'use client';

import { useEffect, useRef } from 'react';

/**
 * Hero "chaos → order" scroll effect (ported from the autoenvia v2 demo).
 * Scattered, problem-laden orders sit around the headline; as you scroll, they
 * converge into a funnel ("acá entran"), shrink and fade — the chaos being
 * absorbed by the system. Decorative: pointer-events-none, aria-hidden, and
 * disabled under reduced-motion / on phones (kept off to keep the hero clean).
 */

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const easeIO = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type Order = { cls: string; rot: number; text: string; late?: boolean };

// Positions live in globals.css (.hero-chaos .o1….o6) so desktop & mobile can be
// tuned independently — on phones they reflow to the 4 corners behind the copy.
const ORDERS: Order[] = [
  { cls: 'o1', rot: -6, text: '#5741 · sin procesar' },
  { cls: 'o2', rot: 4, text: '#5738 · demorado 2 días', late: true },
  { cls: 'o3', rot: -3, text: '#5743 · dirección dudosa' },
  { cls: 'o4', rot: 5, text: '#5740 · sin guía' },
  { cls: 'o5', rot: -5, text: '#5736 · cliente reclama', late: true },
  { cls: 'o6', rot: 3, text: '#5744 · en espera' },
];

export function HeroChaos() {
  const rootRef = useRef<HTMLDivElement>(null);
  const funnelRef = useRef<HTMLDivElement>(null);
  const orderRefs = useRef<HTMLDivElement[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const hero = rootRef.current?.closest('section') as HTMLElement | null;
    const funnel = funnelRef.current;
    const els = orderRefs.current.filter(Boolean);
    const ring = funnel?.querySelector('.ring') as HTMLElement | null;
    if (!hero || !funnel || !ring || !els.length) return;

    const data = els.map((el) => ({ el, dx: 0, dy: 0, rot: parseFloat(el.dataset.rot || '0') }));

    const measure = () => {
      const fr = ring.getBoundingClientRect();
      const fx = fr.left + fr.width / 2;
      const fy = fr.top + fr.height / 2;
      for (const o of data) {
        o.el.style.transform = 'none';
        const r = o.el.getBoundingClientRect();
        o.dx = fx - (r.left + r.width / 2);
        o.dy = fy - (r.top + r.height / 2);
        o.el.style.transform = `rotate(${o.rot}deg)`;
      }
    };

    const frame = () => {
      const hp = easeIO(clamp(window.scrollY / (hero.offsetHeight * 0.85), 0, 1));
      for (const o of data) {
        o.el.style.transform = `translate3d(${(o.dx * hp).toFixed(1)}px, ${(o.dy * hp).toFixed(1)}px, 0) rotate(${(o.rot * (1 - hp)).toFixed(1)}deg) scale(${(1 - hp * 0.6).toFixed(3)})`;
        o.el.style.opacity = (1 - hp * 0.92).toFixed(3);
      }
      funnel.classList.toggle('hot', hp > 0.35 && hp < 0.98);
    };

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          ticking = false;
          frame();
        });
        ticking = true;
      }
    };
    const measureAll = () => {
      measure();
      frame();
    };

    measureAll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measureAll);
    window.addEventListener('load', measureAll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measureAll);
      window.removeEventListener('load', measureAll);
    };
  }, []);

  const collect = (el: HTMLDivElement | null) => {
    if (el && !orderRefs.current.includes(el)) orderRefs.current.push(el);
  };

  return (
    <div ref={rootRef} aria-hidden className="hero-chaos">
      <div className="chaos">
        {ORDERS.map((o, i) => (
          <div
            key={i}
            ref={collect}
            data-rot={o.rot}
            className={`order ${o.cls}${o.late ? ' late' : ''}`}
            style={{ transform: `rotate(${o.rot}deg)` }}
          >
            <i />
            {o.text}
          </div>
        ))}
      </div>
      <div ref={funnelRef} className="funnel">
        <div className="ring">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
          </svg>
        </div>
        <span>acá entran</span>
      </div>
    </div>
  );
}
