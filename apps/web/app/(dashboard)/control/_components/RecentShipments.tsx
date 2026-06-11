'use client';

/**
 * "Ultimos envios" — a global, newest-first feed of executed orders across ALL
 * the user's stores, embedded at the bottom of the control dashboard. Fetched
 * from GET /api/v1/control/recent-labels; refreshes on a slow interval so new
 * shipments appear as runs complete. Each row shows the store, order, status,
 * DAC guia, customer/city, time and a PDF link.
 */

import { useCallback, useEffect, useState } from 'react';
import { ListChecks, Loader2, RefreshCw, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { STATUS_META, STATUS_FILTERS, timeAgo } from './labelMeta';

interface Row {
  id: string;
  orderName: string;
  customer: string;
  city: string;
  status: string;
  dacGuia: string | null;
  errorMessage: string | null;
  createdAt: string;
  hasPdf: boolean;
  store: string;
}

const LIMITS = [40, 100, 200];

export function RecentShipments() {
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(40);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filter === 'all' ? '' : `&status=${filter}`;
      const res = await fetch(`/api/v1/control/recent-labels?limit=${limit}${qs}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No se pudo cargar');
        return;
      }
      setRows(json.data as Row[]);
      setError('');
    } catch {
      setError('Error de conexion');
    } finally {
      setLoading(false);
    }
  }, [filter, limit]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh slowly so new shipments appear as runs complete.
  useEffect(() => {
    const i = setInterval(load, 20000);
    return () => clearInterval(i);
  }, [load]);

  return (
    <div className="glass rounded-2xl p-5 mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Ultimos envios</h2>
          <span className="text-xs text-zinc-500">todas las tiendas{rows ? ` · ${rows.length}` : ''}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-white/[0.07]">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                  filter === f.key ? 'bg-cyan-500 text-zinc-950' : 'bg-white/[0.02] text-zinc-400 hover:text-white',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg overflow-hidden border border-white/[0.07]">
            {LIMITS.map((n) => (
              <button
                key={n}
                onClick={() => setLimit(n)}
                className={cn(
                  'px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                  limit === n ? 'bg-white/[0.1] text-white' : 'bg-white/[0.02] text-zinc-500 hover:text-white',
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            disabled={loading}
            aria-label="Actualizar"
            className="p-1.5 rounded-lg bg-white/[0.03] border border-white/[0.07] text-zinc-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {rows === null ? (
        <div className="flex items-center justify-center py-12 text-zinc-500">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500 py-10 text-center">Sin envios para mostrar.</p>
      ) : (
        <div className="max-h-[560px] overflow-y-auto -mx-1 px-1">
          <div className="space-y-1.5">
            {rows.map((r) => {
              const meta = STATUS_META[r.status] ?? STATUS_META.PENDING;
              const isDone = r.status === 'COMPLETED' || r.status === 'CREATED';
              return (
                <div
                  key={r.id}
                  className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-zinc-300 flex-shrink-0 max-w-[120px] truncate">
                      {r.store}
                    </span>
                    <span className="text-sm font-semibold text-white flex-shrink-0">{r.orderName}</span>
                    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium flex-shrink-0', meta.cls)}>
                      {meta.label}
                    </span>
                    {r.dacGuia && (
                      <span className="font-mono text-[11px] text-emerald-300/90 truncate hidden sm:inline">guia {r.dacGuia}</span>
                    )}
                    <span className="ml-auto text-[10px] text-zinc-500 flex-shrink-0">{timeAgo(r.createdAt)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                    <span className="truncate">
                      {r.customer || 's/d'}
                      {r.city ? ` · ${r.city}` : ''}
                    </span>
                    {r.dacGuia && (
                      <span className="font-mono text-emerald-300/90 sm:hidden">{r.dacGuia}</span>
                    )}
                    {r.hasPdf && (
                      <a
                        href={`/api/v1/control/labels/${r.id}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 transition-colors flex-shrink-0"
                      >
                        <ExternalLink className="w-3 h-3" /> PDF
                      </a>
                    )}
                  </div>
                  {r.errorMessage && !isDone && (
                    <p className="mt-1 text-[10px] text-red-300/80 line-clamp-1">{r.errorMessage}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
