'use client';

import { useRef, useState } from 'react';
import { Upload, Check, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Operator-facing button to manually upload a PDF for a Label that the
 * worker parked NEEDS_REVIEW because the original S3 upload failed.
 *
 * Behavior:
 *   - Hidden <input type="file" accept="application/pdf"> driven by a click
 *     on the visible button.
 *   - On select, POSTs multipart/form-data to /api/v1/labels/{id}/upload-pdf
 *     with field name "pdf".
 *   - On success: brief checkmark, then `onSuccess()` so the parent can
 *     refresh its list.
 *   - On failure: tooltip-style error for ~4s with the server's message.
 *
 * Stops click propagation so clicking inside the row's expandable cell
 * doesn't toggle the row.
 */
export function UploadPdfButton({
  labelId,
  onSuccess,
}: {
  labelId: string;
  onSuccess?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === 'uploading') return;
    inputRef.current?.click();
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice in a row still fires
    // a change event.
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;

    setState('uploading');
    setErrorMsg(null);
    try {
      const form = new FormData();
      form.set('pdf', file);
      const res = await fetch(`/api/v1/labels/${labelId}/upload-pdf`, {
        method: 'POST',
        body: form,
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        data?: { message?: string };
      };
      if (!res.ok) {
        const msg = json.error || `Falló la subida (HTTP ${res.status}).`;
        throw new Error(msg);
      }
      setState('done');
      setTimeout(() => {
        setState('idle');
        onSuccess?.();
      }, 800);
    } catch (err) {
      setState('error');
      setErrorMsg((err as Error).message);
      setTimeout(() => {
        setState('idle');
        setErrorMsg(null);
      }, 4000);
    }
  };

  const Icon = state === 'uploading'
    ? Loader2
    : state === 'done'
    ? Check
    : state === 'error'
    ? AlertCircle
    : Upload;

  const colorClasses = state === 'done'
    ? 'text-emerald-400 hover:text-emerald-300 bg-emerald-500/10'
    : state === 'error'
    ? 'text-red-400 hover:text-red-300 bg-red-500/10'
    : 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10';

  return (
    <span className="relative" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handleChange}
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={state === 'uploading'}
        className={cn(
          'p-1.5 rounded-lg transition-colors',
          colorClasses,
          state === 'uploading' && 'cursor-wait',
        )}
        title={
          state === 'uploading'
            ? 'Subiendo PDF…'
            : state === 'done'
            ? 'PDF subido'
            : state === 'error'
            ? `Error: ${errorMsg ?? 'desconocido'}`
            : 'Subir PDF manualmente (descuenta 1 crédito)'
        }
        aria-label="Subir PDF manualmente"
      >
        <Icon className={cn('w-4 h-4', state === 'uploading' && 'animate-spin')} />
      </button>
      {state === 'error' && errorMsg && (
        <span
          role="alert"
          className="absolute right-0 top-full mt-1.5 z-10 max-w-xs px-2.5 py-1.5 rounded-md bg-red-950/95 border border-red-500/30 text-[11px] text-red-200 shadow-lg whitespace-normal leading-snug"
        >
          {errorMsg}
        </span>
      )}
    </span>
  );
}
