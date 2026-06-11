'use client';

/**
 * "Pedidos ejecutados" modal — lists a store's recent Label rows (executed
 * orders) with status, DAC guia, time and a PDF link. Fetched from
 * GET /api/v1/control/labels (ownership-checked). Opened from a store card on
 * the control dashboard.
 */

import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, FileText, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';

interface LabelRow {
  id: string;
  orderName: string;
  customer: string;
  city: string;
  status: string;
  dacGuia: string | null;
  errorMessage: string | null;
  paymentType: string;
  createdAt: string;
  hasPdf: boolean;
}

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'COMPLETED', label: 'Completados' },
  { key: 'FAILED', label: 'Fallidos' },
  { key: 'NEEDS_REVIEW', label: 'Revisar' },
];

const STATUS_META: Record<string, { label: string; cls: string }> = {
  COMPLETED: { label: 'Completado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  CREATED: { label: 'Creado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  FAILED: { label: 'Fallido', cls: 'text-red-300 bg-red-500/10 border-red-500/20' },
  NEEDS_REVIEW: { label: 'Revisar', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  PENDING: { label: 'Pendiente', cls: 'text-zinc-300 bg-white/[0.04] border-white/10' },
  SKIPPED: { label: 'Omitido', cls: 'text-zinc-400 bg-white/[0.03] border-white/10' },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'ahora';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'recien';
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

export function StoreLabelsModal({
  tenantId,
  tenantName,
  onClose,
}: {
  tenantId: string;
  tenantName: string;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const [rows, setRows] = useState<LabelRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(
    async (f: string) => {
      setRows(null);
      setError('');
      try {
        const qs = f === 'all' ? '' : `&status=${f}`;
        const res = await fetch(`/api/v1/control/labels?tenantId=${encodeURIComponent(tenantId)}&limit=60${qs}`);
        const json = await res.json();
        if (!res.ok) {
          setError(json.error ?? 'No se pudo cargar');
          setRows([]);
          return;
        }
        setRows(json.data as LabelRow[]);
      } catch {
        setError('Error de conexion');
        setRows([]);
      }
    },
    [tenantId],
  );

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative glass rounded-2xl w-full max-w-2xl max-h-[82vh] flex flex-col border border-white/10 shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
          <FileText className="w-4 h-4 text-cyan-400 flex-shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white truncate">Pedidos ejecutados — {tenantName}</h2>
            <p className="text-[11px] text-zinc-500">Etiquetas mas recientes</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="ml-auto p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* filters */}
        <div className="flex items-center gap-1.5 px-5 py-3 border-b border-white/[0.06]">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors',
                filter === f.key ? 'bg-cyan-500 text-zinc-950' : 'bg-white/[0.03] text-zinc-400 hover:text-white',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* body */}
        <div className="overflow-y-auto px-5 py-3 flex-1">
          {error && <p className="text-sm text-red-400 py-4">{error}</p>}
          {rows === null ? (
            <div className="flex items-center justify-center py-16 text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : rows.length === 0 && !error ? (
            <p className="text-sm text-zinc-500 py-12 text-center">No hay pedidos para mostrar.</p>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => {
                const meta = STATUS_META[r.status] ?? STATUS_META.PENDING;
                const isDone = r.status === 'COMPLETED' || r.status === 'CREATED';
                return (
                  <div key={r.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{r.orderName}</span>
                      <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium', meta.cls)}>
                        {meta.label}
                      </span>
                      <span className="ml-auto text-[10px] text-zinc-500 flex-shrink-0">{timeAgo(r.createdAt)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                      <span className="truncate">
                        {r.customer || 's/d'}
                        {r.city ? ` · ${r.city}` : ''}
                      </span>
                      {r.dacGuia && (
                        <span className="ml-auto flex-shrink-0 font-mono text-emerald-300/90">guia {r.dacGuia}</span>
                      )}
                    </div>
                    {r.errorMessage && !isDone && (
                      <p className="mt-1 text-[10px] text-red-300/80 line-clamp-2">{r.errorMessage}</p>
                    )}
                    {r.hasPdf && (
                      <a
                        href={`/api/v1/control/labels/${r.id}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" /> Ver / imprimir PDF
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
