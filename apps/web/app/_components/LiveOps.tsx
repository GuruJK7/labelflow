'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Live "operations console" sections ported from the autoenvia demo.
 *
 * Client islands that bring the demo's signature motion to the landing while
 * staying performant and accessible:
 *   - LivePipeline    — Shopify → AutoEnvía → DAC flow with comet beams,
 *                       an orbital core and a live "guías hoy" counter.
 *   - OperationVersus — manual vs automated, two live feeds (manual makes
 *                       more mistakes); the manual side falls dark at 18:00.
 *   - BatchPrinting   — printing labels one-by-one (manual, never finishes)
 *                       vs one click → 56 labels → single PDF (AutoEnvía).
 *   - ImpactMeters    — animated comparison bars (speed, errors, printing…).
 *
 * All respect `prefers-reduced-motion` (static end-state, no timers) and only
 * start their timers once scrolled into view.
 */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

const pad = (n: number) => String(n).padStart(2, '0');

/* ───────────────────────── Live pipeline ───────────────────────── */

export function LivePipeline() {
  const { ref, inView } = useInView<HTMLElement>(0.3);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (prefersReducedMotion()) {
      setCount(312);
      return;
    }
    const id = setInterval(() => setCount((c) => c + 1), 650);
    return () => clearInterval(id);
  }, [inView]);

  return (
    <section
      ref={ref as React.Ref<HTMLElement>}
      className="lop-panel live-pipeline"
      aria-label="Pipeline de envíos en tiempo real"
    >
      <div className="lop-panel-head">
        <div className="tl">
          <i />
          <i />
          <i />
        </div>
        <span className="name">autoenvia · pipeline</span>
        <span className="live">
          <i />
          LIVE
        </span>
      </div>

      <div className="flow">
        <div className="node shop">
          <div className="ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 7h12l1.5 13.5a1 1 0 0 1-1 1.1H5.5a1 1 0 0 1-1-1.1L6 7z" />
              <path d="M9 10V6a3 3 0 0 1 6 0v4" />
            </svg>
          </div>
          <b>Shopify</b>
          <small>pedidos entrantes</small>
        </div>

        <div className="track t1">
          <div className="beam" />
          <div className="comet" style={{ '--dur': '2.7s', '--del': '0s' } as React.CSSProperties} />
          <div className="comet" style={{ '--dur': '2.7s', '--del': '.9s' } as React.CSSProperties} />
          <div className="comet" style={{ '--dur': '2.7s', '--del': '1.8s' } as React.CSSProperties} />
        </div>

        <div className="node core">
          <div className="ic">
            <div className="orbit" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
            </svg>
          </div>
          <b>AutoEnvía</b>
          <small>valida · genera · emite</small>
        </div>

        <div className="track t2">
          <div className="beam" />
          <div className="comet" style={{ '--dur': '2.5s', '--del': '.4s' } as React.CSSProperties} />
          <div className="comet" style={{ '--dur': '2.5s', '--del': '1.3s' } as React.CSSProperties} />
          <div className="comet" style={{ '--dur': '2.5s', '--del': '2.1s' } as React.CSSProperties} />
        </div>

        <div className="node dac">
          <div className="ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7h11v9H3z" />
              <path d="M14 10h4l3 3v3h-7" />
              <circle cx="7" cy="18.5" r="1.8" />
              <circle cx="17.5" cy="18.5" r="1.8" />
            </svg>
          </div>
          <b>DAC</b>
          <small>guía emitida</small>
        </div>
      </div>

      <div className="pipe-stats">
        <div className="pstat cy">
          <b>{count}</b>
          <span>guías hoy</span>
        </div>
        <div className="pstat em">
          <b>100%</b>
          <span>automático</span>
        </div>
        <div className="pstat">
          <b>0</b>
          <span>intervención humana</span>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Operation versus ───────────────────────── */

type FeedRow = { id: number; ok: boolean; guide: string };

/** A plausible DAC tracking number for an emitted label. */
const dacGuide = () => 'DAC 88212' + Math.floor(40000000 + Math.random() * 9999999);

const STATIC_H: FeedRow[] = [
  { id: 5751, ok: true, guide: 'DAC 8821244019283' },
  { id: 5752, ok: false, guide: '— sin guía' },
  { id: 5753, ok: false, guide: '— sin guía' },
  { id: 5754, ok: true, guide: 'DAC 8821247750162' },
];
const STATIC_A: FeedRow[] = [
  { id: 5760, ok: true, guide: 'DAC 8821243380114' },
  { id: 5761, ok: true, guide: 'DAC 8821248844907' },
  { id: 5762, ok: true, guide: 'DAC 8821242019773' },
];

export function OperationVersus() {
  const { ref, inView } = useInView<HTMLElement>(0.22);
  const [feedH, setFeedH] = useState<FeedRow[]>([]);
  const [feedA, setFeedA] = useState<FeedRow[]>([]);
  const [cntH, setCntH] = useState(0);
  const [errH, setErrH] = useState(0);
  const [cntA, setCntA] = useState(0);
  const [clockH, setClockH] = useState('09:00');
  const [coverH, setCoverH] = useState(false);
  const [on247, setOn247] = useState(false);
  const orderRef = useRef(5733);

  useEffect(() => {
    if (!inView) return;

    if (prefersReducedMotion()) {
      setFeedH(STATIC_H);
      setFeedA(STATIC_A);
      setCntH(21);
      setErrH(8);
      setClockH('18:00');
      setCoverH(true);
      setCntA(312);
      setOn247(true);
      return;
    }

    const push = (
      setter: React.Dispatch<React.SetStateAction<FeedRow[]>>,
      ok: boolean,
    ) => {
      const id = (orderRef.current += 1);
      setter((rows) => [...rows, { id, ok, guide: ok ? dacGuide() : '— sin guía' }].slice(-6));
    };

    // Manual side: slow, makes mistakes often, closes at 18:00.
    let hMin = 0;
    let running = true;
    const hId = setInterval(() => {
      if (!running) return;
      hMin += 40;
      const hh = 9 + Math.floor(hMin / 60);
      const mm = hMin % 60;
      setClockH(`${pad(Math.min(hh, 18))}:${pad(hh >= 18 ? 0 : mm)}`);
      if (hh >= 18) {
        running = false;
        setCoverH(true);
        return;
      }
      if (Math.random() < 0.6) {
        // ~42% of manual shipments go out wrong.
        const ok = Math.random() > 0.42;
        push(setFeedH, ok);
        if (ok) setCntH((c) => c + 1);
        else setErrH((c) => c + 1);
      }
    }, 1500);

    // Automated side: steady cascade, lights the 24/7 chip after a few.
    let aCount = 0;
    const aId = setInterval(() => {
      push(setFeedA, true);
      aCount += 1;
      setCntA(aCount);
      if (aCount === 7) setOn247(true);
    }, 620);

    return () => {
      clearInterval(hId);
      clearInterval(aId);
    };
  }, [inView]);

  return (
    <div ref={ref as React.Ref<HTMLDivElement>} className="op-versus">
      {/* Manual */}
      <div className="lop-panel side human">
        <div className="hd">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="8" r="3.5" />
            <path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />
          </svg>
          <b>Proceso manual</b>
          <span className="chip">{clockH}</span>
        </div>
        <div className="feed">
          {feedH.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </div>
        <div className="ft">
          <div>
            <span>Procesados</span>
            <b>{cntH}</b>
          </div>
          <div className="e">
            <span>Errores</span>
            <b>{errH}</b>
          </div>
          <div>
            <span>Horario</span>
            <b>9–18</b>
          </div>
        </div>
        <div className={`nightfall${coverH ? ' show' : ''}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
          </svg>
          <b>Fuera de horario</b>
          <span>se retoma mañana · 09:00</span>
        </div>
      </div>

      {/* Automated */}
      <div className="lop-panel side auto">
        <div className="hd">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
          </svg>
          <b>Con AutoEnvía</b>
          <span className={`chip c247${on247 ? ' on' : ''}`}>24 / 7</span>
        </div>
        <div className="feed">
          {feedA.map((r) => (
            <Row key={r.id} row={r} />
          ))}
        </div>
        <div className="ft">
          <div>
            <span>Procesados</span>
            <b>{cntA}</b>
          </div>
          <div className="e">
            <span>Errores humanos</span>
            <b>0</b>
          </div>
          <div>
            <span>Horario</span>
            <b>24/7</b>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ row }: { row: FeedRow }) {
  return (
    <div className={`row ${row.ok ? 'ok' : 'err'}`}>
      <span className="id">#{row.id}</span>
      <span className="dac">{row.guide}</span>
      <span className="st">
        <i />
        {row.ok ? 'emitida' : 'dirección inválida'}
      </span>
    </div>
  );
}

/* ───────────────────────── Batch printing ───────────────────────── */

type Label = { id: number; y: number; rot: number; z: number };

const TOTAL_LABELS = 56;
const STACK_MAX = 13;

function makeLabel(idx: number, neat: boolean): Label {
  // Stack grows upward then settles; manual labels land slightly crooked.
  // Tuned to the compact 86px-tall stackzone with 26px labels.
  const y = 58 - Math.min(idx, 12) * 4;
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

    // Automated: click → 56 labels at once → single PDF → repeat.
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
          <b>Etiquetas una por una</b>
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
          <span className="holdnote">abrir PDF → imprimir → siguiente…</span>
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
          <b>Con AutoEnvía</b>
          <span className="chip clic">1 clic</span>
        </div>
        <div className="pstage">
          <button className={`printbtn${aPressed ? ' press' : ''}`} tabIndex={-1} aria-hidden="true" type="button">
            <PrinterIcon />
            Imprimir día · 56
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

/* ───────────────────────── Impact meters ───────────────────────── */

type Meter = {
  lab: string;
  manual: { w: string; val: string };
  auto: { w: string; val: string };
};

const METERS: Meter[] = [
  { lab: 'Velocidad', manual: { w: '9%', val: '~25 /día' }, auto: { w: '96%', val: '+300 /día' } },
  { lab: 'Errores humanos', manual: { w: '16%', val: '~16%' }, auto: { w: '100%', val: '0' } },
  { lab: 'Impresión', manual: { w: '8%', val: '1 × 1' }, auto: { w: '100%', val: 'todas · 1 clic' } },
  { lab: 'Cobertura', manual: { w: '37%', val: '9 h/día' }, auto: { w: '100%', val: '24 h/día' } },
  { lab: 'Costo mensual', manual: { w: '90%', val: '1 sueldo' }, auto: { w: '12%', val: 'una fracción' } },
];

export function ImpactMeters() {
  const { ref, inView } = useInView<HTMLElement>(0.3);

  return (
    <section ref={ref as React.Ref<HTMLElement>} className="lop-panel impact-meters" aria-label="Comparativa de resultados">
      {METERS.map((m) => (
        <div className="crow" key={m.lab}>
          <span className="lab">{m.lab}</span>
          <div className="meter dim">
            <div className="bar">
              <i style={{ width: inView ? m.manual.w : '0%' }} />
            </div>
            <b>{m.manual.val}</b>
          </div>
          <div className="meter lit">
            <div className="bar">
              <i style={{ width: inView ? m.auto.w : '0%' }} />
            </div>
            <b>{m.auto.val}</b>
          </div>
        </div>
      ))}
    </section>
  );
}
