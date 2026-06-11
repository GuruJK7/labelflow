'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { User, Zap } from 'lucide-react';

/**
 * Stress test — "¿Y cuando el volumen crece?". A per-day orders slider: a human
 * operator (sustainable ~40 guías/day) saturates and collapses while AutoEnvía
 * stays flat up to 4.000/day. Ported 1:1 from the autoenvia stress-test demo
 * (same caps, thresholds, copy) as a controlled React input.
 */

const MIN = 10;
const MAX = 4000; // CAP_A — capacidad de AutoEnvía
const CAP_H = 40; // capacidad sostenible de una persona
const fmt = (n: number) => n.toLocaleString('es-UY');

export function StressTest() {
  const [orders, setOrders] = useState(90);
  const rowRef = useRef<HTMLDivElement>(null);

  // Operario: colapsa pasando 40
  const humanPct = Math.min(orders / CAP_H, 1) * 100;
  const humanClass = orders <= 25 ? 'ok' : orders <= CAP_H ? 'warn' : 'boom';
  const humanStt =
    orders <= 25 ? 'al día' : orders <= CAP_H ? 'horas extra · al límite' : 'colapsado';

  // AutoEnvía: plano hasta 4.000
  const autoPct = (orders / MAX) * 100;
  const autoStt = orders >= MAX ? `a tope · ${fmt(MAX)}/día ✓` : 'procesando · sin despeinarse';

  const fill = (((orders - MIN) / (MAX - MIN)) * 100).toFixed(2) + '%';
  const backlog =
    orders > CAP_H
      ? `hoy quedan ${fmt(orders - CAP_H)} pedidos sin despachar → mañana arrancás atrasado`
      : '';

  // Re-dispara el "temblor" del operario cada vez que lo empujás más allá del tope.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const row = rowRef.current;
    if (!row) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    row.classList.remove('shake');
    if (orders > CAP_H) {
      void row.offsetWidth; // reinicia la animación
      row.classList.add('shake');
    }
  }, [orders]);

  return (
    <div className="lop-panel stress">
      <div className="rglow" aria-hidden />

      <div className="top">
        <label htmlFor="stRange">Pedidos por día</label>
        <output htmlFor="stRange">
          {fmt(orders)} <small>PEDIDOS/DÍA</small>
        </output>
      </div>

      <input
        type="range"
        id="stRange"
        min={MIN}
        max={MAX}
        step={10}
        value={orders}
        onChange={(e) => setOrders(parseInt(e.target.value, 10))}
        style={{ '--fill': fill } as CSSProperties}
        aria-label="Pedidos por día"
      />
      <div className="marks">
        <span>10</span>
        <span>1.000</span>
        <span>2.000</span>
        <span>3.000</span>
        <span>4.000</span>
      </div>

      <div className="rows">
        <div ref={rowRef} className="strow">
          <span className="who">
            <User className="w-3.5 h-3.5" />
            Operario
          </span>
          <div className="stbar">
            <i className={humanClass} style={{ width: `${humanPct}%` }} />
          </div>
          <span className={orders > CAP_H ? 'stt bad' : 'stt'}>{humanStt}</span>
        </div>
        <div className="strow">
          <span className="who" style={{ color: 'var(--cyan)' }}>
            <Zap className="w-3.5 h-3.5" />
            AutoEnvía
          </span>
          <div className="stbar">
            <i className="ok" style={{ width: `${autoPct}%` }} />
          </div>
          <span className="stt good">{autoStt}</span>
        </div>
      </div>

      <div className="stback">{backlog}</div>
      <p className="foot">
        capacidad manual estimada: ~40 guías/día por persona · capacidad AutoEnvía: 4.000
        pedidos/día
      </p>
    </div>
  );
}
