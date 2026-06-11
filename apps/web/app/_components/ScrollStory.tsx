'use client';

import { useEffect, useRef } from 'react';

/**
 * Scrollytelling — "Seguí un pedido": a scroll-pinned section where the user's
 * scroll pushes order #5741 through the pipeline (Shopify → AutoEnvía → DAC).
 * Nodes light up as the packet arrives, the AI address-fix card appears during
 * validation, the DAC guide is emitted at the end, captions cross-fade and a
 * scrub bar tracks progress. Ported from the autoenvia v4 demo.
 *
 * Fully scrubbed by scroll position over the tall (.scroll-story) container.
 * Under reduced-motion the section un-pins (CSS) and renders the final state.
 */

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const easeIO = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function ScrollStory() {
  const storyRef = useRef<HTMLElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const pktRef = useRef<HTMLDivElement>(null);
  const shopRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const dacRef = useRef<HTMLDivElement>(null);
  const bf1Ref = useRef<HTMLDivElement>(null);
  const bf2Ref = useRef<HTMLDivElement>(null);
  const cap1Ref = useRef<HTMLDivElement>(null);
  const cap2Ref = useRef<HTMLDivElement>(null);
  const cap3Ref = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLSpanElement>(null);
  const fixRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const story = storyRef.current;
    const flow = flowRef.current;
    const pkt = pktRef.current;
    const shop = shopRef.current;
    const core = coreRef.current;
    const dac = dacRef.current;
    const bf1 = bf1Ref.current;
    const bf2 = bf2Ref.current;
    const caps = [cap1Ref.current, cap2Ref.current, cap3Ref.current];
    const stage = stageRef.current;
    const fix = fixRef.current;
    const guide = guideRef.current;
    const scrub = scrubRef.current;
    const hint = hintRef.current;
    if (!story || !flow || !pkt || !shop || !core || !dac || !bf1 || !bf2 || !stage || !fix || !guide || !scrub || !hint) {
      return;
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const geo = { A: 0, B: 0, C: 0 };
    const setCap = (i: number) => caps.forEach((c, j) => c && c.classList.toggle('show', j === i));

    const measureFlow = () => {
      const icS = shop.querySelector('.ic') as HTMLElement | null;
      const icC = core.querySelector('.ic') as HTMLElement | null;
      const icD = dac.querySelector('.ic') as HTMLElement | null;
      if (!icS || !icC || !icD) return;
      geo.A = shop.offsetLeft + icS.offsetLeft + icS.offsetWidth / 2;
      geo.B = core.offsetLeft + icC.offsetLeft + icC.offsetWidth / 2;
      geo.C = dac.offsetLeft + icD.offsetLeft + icD.offsetWidth / 2;
      pkt.style.top = shop.offsetTop + icS.offsetTop + icS.offsetHeight / 2 + 'px';
    };

    if (reduced) {
      measureFlow();
      shop.classList.add('on');
      core.classList.add('on');
      dac.classList.add('on');
      bf1.style.width = '100%';
      bf2.style.width = '100%';
      pkt.classList.add('delivered');
      pkt.style.left = geo.C + 'px';
      guide.classList.add('show');
      setCap(2);
      stage.textContent = 'guía emitida ✓';
      stage.className = 'stagechip s3';
      hint.classList.add('off');
      return;
    }

    const t1 = flow.querySelector('.t1') as HTMLElement | null;
    const t2 = flow.querySelector('.t2') as HTMLElement | null;

    const storyFrame = () => {
      const r = story.getBoundingClientRect();
      const total = r.height - window.innerHeight;
      const p = total > 0 ? clamp(-r.top / total, 0, 1) : 0;
      scrub.style.width = p * 100 + '%';
      hint.classList.toggle('off', p > 0.04);

      let x: number;
      if (p < 0.4) {
        x = geo.A + (geo.B - geo.A) * easeIO(p / 0.4);
        shop.classList.add('on');
        core.classList.toggle('on', p > 0.34);
        core.classList.remove('busy');
        dac.classList.remove('on');
        fix.classList.remove('show');
        guide.classList.remove('show');
        pkt.classList.remove('delivered');
        setCap(0);
        stage.textContent = 'en cola';
        stage.className = 'stagechip';
      } else if (p < 0.6) {
        x = geo.B;
        shop.classList.add('on');
        core.classList.add('on', 'busy');
        dac.classList.remove('on');
        fix.classList.add('show');
        guide.classList.remove('show');
        pkt.classList.remove('delivered');
        setCap(1);
        stage.textContent = 'validando · IA';
        stage.className = 'stagechip s2';
      } else {
        x = geo.B + (geo.C - geo.B) * easeIO(clamp((p - 0.6) / 0.34, 0, 1));
        shop.classList.add('on');
        core.classList.add('on');
        core.classList.remove('busy');
        fix.classList.remove('show');
        const done = p >= 0.94;
        dac.classList.toggle('on', done);
        guide.classList.toggle('show', done);
        pkt.classList.toggle('delivered', done);
        setCap(done ? 2 : 1);
        if (done) {
          stage.textContent = 'guía emitida ✓';
          stage.className = 'stagechip s3';
        } else {
          stage.textContent = 'generando guía';
          stage.className = 'stagechip s2';
        }
      }
      pkt.style.left = x + 'px';

      if (t1 && t2) {
        bf1.style.left = '0';
        bf1.style.width = clamp((x - t1.offsetLeft) / t1.clientWidth, 0, 1) * 100 + '%';
        bf2.style.left = '0';
        bf2.style.width = clamp((x - t2.offsetLeft) / t2.clientWidth, 0, 1) * 100 + '%';
      }
    };

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          ticking = false;
          storyFrame();
        });
        ticking = true;
      }
    };
    const measureAll = () => {
      measureFlow();
      storyFrame();
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

  return (
    <section ref={storyRef} id="operacion" className="scroll-story">
      <div className="stick">
        <div className="mx-auto w-full max-w-[1020px]">
          <div className="ss-tag relative isolate">
            <span aria-hidden className="lop-ghost">01</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 3" />
            </svg>
            SEGUÍ UN PEDIDO
          </div>

          <div className="lop-panel spanel">
            <div className="lop-panel-head">
              <div className="tl">
                <i />
                <i />
                <i />
              </div>
              <span className="name">autoenvia · pedido #5741</span>
              <span ref={stageRef} className="stagechip">
                en cola
              </span>
            </div>

            <div ref={flowRef} className="flow">
              <div ref={shopRef} className="node shop">
                <div className="ic">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 7h12l1.5 13.5a1 1 0 0 1-1 1.1H5.5a1 1 0 0 1-1-1.1L6 7z" />
                    <path d="M9 10V6a3 3 0 0 1 6 0v4" />
                  </svg>
                </div>
                <b>Shopify</b>
                <small>pedido pago</small>
              </div>

              <div className="track t1">
                <div className="beam" />
                <div ref={bf1Ref} className="beamfill" />
              </div>

              <div ref={coreRef} className="node core">
                <div className="ic">
                  <div className="orbit" />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
                  </svg>
                </div>
                <b>AutoEnvía</b>
                <small>valida · corrige · emite</small>
                <div ref={fixRef} className="fixcard">
                  Av. Italia <s>123o apto3</s> → <b>1230, apto 3 ✓</b>
                </div>
              </div>

              <div className="track t2">
                <div className="beam" />
                <div ref={bf2Ref} className="beamfill" />
              </div>

              <div ref={dacRef} className="node dac">
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
                <div ref={guideRef} className="guideout">
                  DAC 8821247935396 ✓
                </div>
              </div>

              <div ref={pktRef} className="pkt" />
            </div>

            <div className="caps">
              <div ref={cap1Ref} className="cap show">
                <span className="n">01</span>
                <p>
                  Pedido pago detectado en tu Shopify — <strong>entra a la cola en menos de 5 segundos.</strong>
                </p>
              </div>
              <div ref={cap2Ref} className="cap">
                <span className="n">02</span>
                <p>
                  AutoEnvía valida inventario y <strong>corrige la dirección con IA</strong> antes de tocar DAC.
                </p>
              </div>
              <div ref={cap3Ref} className="cap">
                <span className="n">03</span>
                <p>
                  <strong>Guía DAC emitida.</strong> PDF listo, cliente notificado. Sin que nadie tocara nada.
                </p>
              </div>
            </div>

            <div className="scrub">
              <i ref={scrubRef} />
            </div>
          </div>

          <div ref={hintRef} className="scrollhint">
            ↓ scrolleá para empujar el pedido
          </div>
        </div>
      </div>
    </section>
  );
}
