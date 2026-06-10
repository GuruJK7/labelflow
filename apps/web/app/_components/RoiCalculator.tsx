'use client';

import { useState, type CSSProperties } from 'react';
import { Calculator, ArrowRight } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';

/**
 * ROI calculator — "Calculá tu ahorro". A slider for monthly orders that live-
 * computes hours recovered, person-days freed and human errors avoided.
 * Ported 1:1 from the autoenvia v4 demo (same estimates: ~4 min per manual
 * label, ~16% manual error rate), as a controlled React input.
 */

const fmt = (n: number) => n.toLocaleString('es-UY');

const MIN = 100;
const MAX = 5000;

export function RoiCalculator({ whatsappUrl }: { whatsappUrl: string }) {
  const [orders, setOrders] = useState(500);

  const hrs = Math.round((orders * 4) / 60);
  const days = (hrs / 8).toFixed(1).replace('.', ',');
  const errs = Math.round(orders * 0.16);
  const fill = (((orders - MIN) / (MAX - MIN)) * 100).toFixed(1) + '%';

  return (
    <section id="roi" className="py-16 md:py-24 px-4 sm:px-6">
      <div className="max-w-5xl mx-auto">
        <ScrollReveal>
          <div className="text-center mb-10 sm:mb-12">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
              <Calculator className="w-3.5 h-3.5" />
              Calculá tu ahorro
            </div>
            <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight">
              ¿Cuánto te cuesta hoy <span className="text-zinc-500">el proceso manual?</span>
            </h2>
            <p className="text-zinc-400 max-w-2xl mx-auto mt-4 leading-relaxed text-sm sm:text-base">
              Mové el slider a tu volumen real y mirá lo que estás dejando en la mesa cada mes.
            </p>
          </div>
        </ScrollReveal>

        <ScrollReveal variant="scale">
          <div className="lop-panel roi">
            <div className="rglow" aria-hidden />

            <div className="roi-top">
              <label htmlFor="roiRange">Pedidos por mes</label>
              <output htmlFor="roiRange">
                {fmt(orders)} <small>PEDIDOS</small>
              </output>
            </div>

            <input
              type="range"
              id="roiRange"
              min={MIN}
              max={MAX}
              step={50}
              value={orders}
              onChange={(e) => setOrders(parseInt(e.target.value, 10))}
              style={{ '--fill': fill } as CSSProperties}
              aria-label="Pedidos por mes"
            />
            <div className="marks">
              <span>100</span>
              <span>1.250</span>
              <span>2.500</span>
              <span>3.750</span>
              <span>5.000</span>
            </div>

            <div className="roi-out">
              <div className="rstat">
                <b>{fmt(hrs)} h</b>
                <span>
                  recuperadas
                  <br />
                  por mes
                </span>
              </div>
              <div className="rstat">
                <b>{days}</b>
                <span>
                  días-persona
                  <br />
                  liberados por mes
                </span>
              </div>
              <div className="rstat warn">
                <b>{fmt(errs)}</b>
                <span>
                  errores humanos
                  <br />
                  evitados por mes
                </span>
              </div>
            </div>

            <div className="cta-inline">
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 bg-gradient-to-r from-cyan-400 to-emerald-400 text-[#02161b] font-display font-bold text-sm px-7 py-3.5 rounded-xl shadow-lg shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:-translate-y-0.5 transition-all"
              >
                Quiero recuperar esas horas
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </a>
            </div>

            <p className="foot">estimación: ~4 min por guía manual · ~16% de tasa de error típica en carga manual</p>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
