'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * BatchPrinting — la impresión del día, una por una contra un solo clic.
 *
 * Es lo único que sobrevivió del "operations console" portado del demo v4
 * (LivePipeline, OperationVersus e ImpactMeters se borraron en el rediseño de
 * la landing). El motivo: las otras tres animaban números que nadie podía
 * respaldar —"guías hoy" en vivo sin un solo fetch, tasas de error, velocidad
 * comparada— y encima el hero las presentaba como "operación en vivo".
 *
 * Esta se queda porque ilustra algo que el producto hace de verdad y se puede
 * verificar: `POST /api/v1/labels/bulk` mergea las etiquetas del día en un
 * único PDF con pdf-lib. Por eso TOTAL_LABELS baja de 56 a 48: el endpoint
 * acepta como máximo 50 ids por request (`bulkSchema`), y una demo que muestre
 * más etiquetas de las que el sistema junta de una sería otra vez ficción.
 *
 * Sigue siendo una demostración, no datos de un cliente: la sección que la
 * contiene lo dice con todas las letras.
 *
 * Respeta `prefers-reduced-motion` (estado final estático, sin timers) y sólo
 * arranca los timers cuando entra en viewport.
 */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const isMobile = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(max-width: 760px)').matches;

/** Flip `inView` true the first time the element enters the viewport. */
function useInView<T extends HTMLElement>(threshold = 0.3) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            obs.unobserve(entry.target);
          }
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);

  return { ref, inView };
}

/* ───────────────────────── Batch printing ───────────────────────── */

type Label = { id: number; y: number; rot: number; z: number };

const TOTAL_LABELS = 48;
const STACK_MAX = 13;

/** Position a label inside the stack — tuned to the actual zone height per
 *  breakpoint (compact desktop vs even smaller mobile), so labels never spill. */
function makeLabel(idx: number, neat: boolean): Label {
  const mobile = isMobile();
  const zoneH = mobile ? 72 : 86;
  const lblH = mobile ? 22 : 26;
  const y = zoneH - lblH - 2 - Math.min(idx, 12) * 4;
  const rot = neat ? 0 : Math.random() * 8 - 4;
  return { id: idx, y, rot, z: idx };
}

const PrinterIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 8V3h10v5" />
    <path d="M5 8h14a2 2 0 0 1 2 2v6h-4" />
    <path d="M7 16H3v-6a2 2 0 0 1 2-2" />
    <path d="M7 13h10v8H7z" />
  </svg>
);

function LabelEl({ label }: { label: Label }) {
  return (
    <div
      className="lbl"
      style={{ '--y': `${label.y}px`, '--rot': `rotate(${label.rot}deg)`, zIndex: label.z } as React.CSSProperties}
    >
      <span className="strip" />
      <span className="bars" />
      <small>DAC</small>
    </div>
  );
}

export function BatchPrinting() {
  const { ref, inView } = useInView<HTMLElement>(0.25);
  const [mLabels, setMLabels] = useState<Label[]>([]);
  const [mCount, setMCount] = useState(0);
  const [mMins, setMMins] = useState(0);
  const [aLabels, setALabels] = useState<Label[]>([]);
  const [aCount, setACount] = useState(0);
  const [aPressed, setAPressed] = useState(false);
  const [aDone, setADone] = useState(false);

  useEffect(() => {
    if (!inView) return;

    if (prefersReducedMotion()) {
      setMLabels(Array.from({ length: 8 }, (_, i) => makeLabel(i + 1, false)));
      setMCount(8);
      setMMins(45);
      setALabels(Array.from({ length: STACK_MAX }, (_, i) => makeLabel(i + 1, true)));
      setACount(TOTAL_LABELS);
      setADone(true);
      return;
    }

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const intervals: ReturnType<typeof setInterval>[] = [];

    // Manual: one label every 1.8s — never reaches the full batch.
    let mIdx = 0;
    intervals.push(
      setInterval(() => {
        mIdx += 1;
        const cur = mIdx;
        setMLabels((ls) => [...ls, makeLabel(cur, false)].slice(-STACK_MAX));
        setMCount(Math.min(cur, TOTAL_LABELS));
        setMMins((m) => m + 1);
        if (mIdx >= TOTAL_LABELS) {
          mIdx = 0;
          setMLabels([]);
          setMCount(0);
          setMMins(0);
        }
      }, 1800),
    );

    // Automated: click → 48 labels at once → single PDF → repeat.
    const runCycle = () => {
      if (cancelled) return;
      setALabels([]);
      setACount(0);
      setADone(false);
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setAPressed(true);
          timers.push(setTimeout(() => setAPressed(false), 550));
          let i = 0;
          const burst = setInterval(() => {
            i += 1;
            const cur = i;
            setALabels((ls) => [...ls, makeLabel(cur, true)].slice(-STACK_MAX));
            setACount(cur);
            if (i >= TOTAL_LABELS) {
              clearInterval(burst);
              setADone(true);
              timers.push(setTimeout(runCycle, 3600));
            }
          }, 42);
          intervals.push(burst);
        }, 1100),
      );
    };
    runCycle();

    return () => {
      cancelled = true;
      intervals.forEach(clearInterval);
      timers.forEach(clearTimeout);
    };
  }, [inView]);

  return (
    <div ref={ref as React.Ref<HTMLDivElement>} className="batch-print">
      {/* Manual */}
      <div className="lop-panel pside human">
        <div className="hd">
          <PrinterIcon />
          <b>Una por una</b>
          <span className="chip">~{mMins} min</span>
        </div>
        <div className="pstage">
          <div className="printer">
            <i className="led" />
          </div>
          <div className="stackzone">
            {mLabels.map((l) => (
              <LabelEl key={l.id} label={l} />
            ))}
          </div>
          <span className="holdnote">abrir PDF → imprimir → seguir…</span>
        </div>
        <div className="pmeter">
          <b>
            {mCount}
            <span className="of"> / {TOTAL_LABELS}</span>
          </b>
          <span>etiquetas</span>
        </div>
      </div>

      {/* Automated */}
      <div className="lop-panel pside auto">
        <div className="hd">
          <PrinterIcon />
          <b>AutoEnvía</b>
          <span className="chip clic">1 clic</span>
        </div>
        <div className="pstage">
          <button className={`printbtn${aPressed ? ' press' : ''}`} tabIndex={-1} aria-hidden="true" type="button">
            <PrinterIcon />
            Imprimir día · 48
          </button>
          <div className="stackzone">
            {aLabels.map((l) => (
              <LabelEl key={l.id} label={l} />
            ))}
          </div>
        </div>
        <div className="pmeter">
          <b>
            {aCount}
            <span className="of"> / {TOTAL_LABELS}</span>
          </b>
          <span>etiquetas</span>
          <span className={`done${aDone ? ' show' : ''}`}>
            <i />
            PDF único listo
          </span>
        </div>
      </div>
    </div>
  );
}

