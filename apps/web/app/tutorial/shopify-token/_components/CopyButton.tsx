'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Copy-to-clipboard button used across the tutorial page.
 *
 * Splits out the only piece of interactivity on what's otherwise a static,
 * server-rendered page — keeps the page itself a server component (zero JS
 * cost for first paint) and isolates the `'use client'` boundary to this
 * tiny island.
 *
 * Behavior: shows "Copiado" for 1.5s after a successful write, falls back
 * silently if `navigator.clipboard` is unavailable (insecure context, old
 * Safari) — the user can still select the visible text manually.
 */
export function CopyButton({
  value,
  label,
  ariaLabel,
  variant = 'default',
  className,
}: {
  value: string;
  /** Visible text next to the icon. Pass `""` for icon-only. */
  label?: string;
  /** Override for the SR-only label. Defaults to "Copiar al portapapeles". */
  ariaLabel?: string;
  variant?: 'default' | 'small' | 'pill';
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard denied — user copies manually */
      });
  };

  const styles =
    variant === 'small'
      ? 'text-[11px] px-2 py-1 gap-1.5'
      : variant === 'pill'
      ? 'text-xs px-3 py-1.5 gap-2 rounded-full'
      : 'text-sm px-3 py-2 gap-2';

  return (
    <button
      type="button"
      onClick={onCopy}
      className={cn(
        'inline-flex items-center font-medium rounded-md border transition-colors',
        copied
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-cyan-500/25 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/15 hover:border-cyan-500/40',
        styles,
        className,
      )}
      aria-label={
        copied
          ? 'Copiado'
          : ariaLabel ?? (label ? `Copiar ${label}` : 'Copiar al portapapeles')
      }
    >
      {copied ? (
        <>
          <Check className="w-3.5 h-3.5" /> Copiado
        </>
      ) : (
        <>
          <Copy className="w-3.5 h-3.5" /> {label ?? 'Copiar'}
        </>
      )}
    </button>
  );
}
