'use client';

import type { ReactNode } from 'react';
import { Loader2, ArrowRight, ArrowLeft, CheckCircle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Piezas visuales compartidas por los pasos del wizard. Mismo lenguaje que el
 * resto del producto: fondo oscuro, un solo acento cyan, tarjetas glass.
 * Sin emojis: los estados se marcan con iconos de lucide.
 */

export const inputClass =
  'w-full px-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all';
export const labelClass = 'block text-xs font-medium text-zinc-400 mb-1.5';

export function StepCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('glass rounded-2xl p-6 sm:p-8 animate-fade-in', className)}>{children}</div>;
}

export function StepHeader({
  icon: Icon,
  title,
  text,
  estimate,
}: {
  icon: typeof CheckCircle;
  title: string;
  text?: ReactNode;
  estimate?: string;
}) {
  return (
    <div className="flex items-start gap-3 mb-6">
      <div className="w-10 h-10 rounded-xl bg-cyan-500/15 ring-1 ring-cyan-500/30 flex items-center justify-center flex-shrink-0">
        <Icon className="w-5 h-5 text-cyan-400" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-xl font-bold text-white">{title}</h2>
          {estimate && (
            <span className="text-[10px] uppercase tracking-wide text-zinc-500 border border-white/[0.08] rounded-md px-1.5 py-0.5">
              {estimate}
            </span>
          )}
        </div>
        {text && <p className="text-zinc-500 text-sm mt-0.5 leading-relaxed">{text}</p>}
      </div>
    </div>
  );
}

export function PrimaryButton({
  children,
  busy,
  busyLabel,
  disabled,
  onClick,
  type = 'button',
  className,
  arrow = true,
}: {
  children: ReactNode;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  className?: string;
  arrow?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        'inline-flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white px-6 py-3 rounded-xl text-sm font-medium transition-all disabled:opacity-60 disabled:cursor-not-allowed',
        className,
      )}
    >
      {busy ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          {busyLabel ?? 'Un momento…'}
        </>
      ) : (
        <>
          {children}
          {arrow && <ArrowRight className="w-4 h-4" />}
        </>
      )}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  className,
  back = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  back?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 px-5 py-3 rounded-xl border border-white/[0.08] text-zinc-400 text-sm hover:bg-white/[0.03] hover:text-zinc-200 transition-colors disabled:opacity-50',
        className,
      )}
    >
      {back && <ArrowLeft className="w-3.5 h-3.5" />}
      {children}
    </button>
  );
}

export function Notice({ kind, children }: { kind: 'ok' | 'error' | 'info' | 'warn'; children: ReactNode }) {
  const styles = {
    ok: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
    error: 'bg-red-500/10 border-red-500/20 text-red-300',
    info: 'bg-cyan-500/[0.06] border-cyan-500/20 text-cyan-100/90',
    warn: 'bg-amber-500/10 border-amber-500/20 text-amber-200',
  }[kind];
  const Icon = kind === 'ok' ? CheckCircle : AlertCircle;
  return (
    <div className={cn('px-4 py-3 rounded-xl border text-sm flex items-start gap-2 leading-relaxed', styles)}>
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Tarjeta verde de "esto ya está" con botón Cambiar. */
export function DoneCard({ title, detail, onChange }: { title: string; detail?: string | null; onChange?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
      <div className="flex items-center gap-2 min-w-0">
        <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm text-emerald-200 font-medium">{title}</p>
          {detail && <p className="text-xs text-emerald-300/70 truncate">{detail}</p>}
        </div>
      </div>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          className="text-xs text-zinc-400 hover:text-white underline underline-offset-2 flex-shrink-0"
        >
          Cambiar
        </button>
      )}
    </div>
  );
}

export function StepFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-6 mt-6 border-t border-white/[0.06]">{children}</div>;
}
