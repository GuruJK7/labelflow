'use client';

import { useEffect, useState, useCallback } from 'react';
import { PrintButton } from '@/components/printing/PrintButton';
import { BulkActionBar } from '@/components/labels/BulkActionBar';
import {
  FileText,
  Download,
  Calendar,
  Search,
  RefreshCw,
  FolderOpen,
  Clock,
  Check,
  Minus,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface LabelFile {
  id: string;
  shopifyOrderName: string;
  customerName: string;
  dacGuia: string | null;
  status: string;
  pdfPath: string | null;
  pdfUrl: string | null;
  createdAt: string;
  totalUyu: number;
  city: string;
}

export default function LabelsPage() {
  const [labels, setLabels] = useState<LabelFile[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState<'print' | 'download' | null>(null);
  const [redoing, setRedoing] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setSelectedIds(new Set());
    try {
      const params = new URLSearchParams({ limit: '50', status: 'COMPLETED', hasPdf: 'true' });
      if (search) params.set('search', search);
      if (dateFilter) params.set('date', dateFilter);
      const res = await fetch(`/api/v1/orders?${params}`);
      if (res.ok) {
        const { data, meta } = await res.json();
        setLabels(data ?? []);
        setTotal(meta?.total ?? 0);
      }
    } catch {
      // silent
    }
    setLoading(false);
  }, [search, dateFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Keyboard shortcuts: Ctrl+A to select all, Escape to clear
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        const allWithPdf = labels.filter((l) => l.pdfPath).map((l) => l.id);
        setSelectedIds(new Set(allWithPdf));
      }
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [labels]);

  // Selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectGroup = (ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const getGroupState = (ids: string[]): 'none' | 'some' | 'all' => {
    if (ids.length === 0) return 'none';
    const selectedInGroup = ids.filter((id) => selectedIds.has(id)).length;
    if (selectedInGroup === 0) return 'none';
    if (selectedInGroup === ids.length) return 'all';
    return 'some';
  };

  // Bulk actions
  const handleBulk = async (mode: 'print' | 'download') => {
    if (selectedIds.size === 0) return;
    setBulkLoading(mode);
    try {
      const downloadParam = mode === 'download' ? '?download=true' : '';
      const res = await fetch(`/api/v1/labels/bulk${downloadParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Error desconocido' }));
        alert(err.error ?? 'Error al procesar etiquetas');
        return;
      }

      const failedHeader = res.headers.get('X-Labels-Failed');
      if (failedHeader && parseInt(failedHeader) > 0) {
        console.warn(`${failedHeader} etiquetas fallaron al procesar`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      if (mode === 'print') {
        const win = window.open(url, '_blank');
        if (win) {
          win.addEventListener('load', () => {
            setTimeout(() => win.print(), 500);
          });
        }
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = 'etiquetas.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      console.error('Bulk action error:', err);
      alert('Error de conexion al procesar etiquetas');
    } finally {
      setBulkLoading(null);
    }
  };

  // Operator-initiated "Reenviar" — deletes Label + PendingShipment so the
  // worker's duplicate-shipment guards (see process-orders.job.ts picker
  // and assertNoPriorSubmit) release the order for reprocessing. The next
  // cron tick picks it up from Shopify's unfulfilled set and creates a
  // fresh DAC guía.
  const handleRedo = async (label: LabelFile) => {
    const confirmed = window.confirm(
      `¿Reenviar ${label.shopifyOrderName}?\n\n` +
        `Guía actual: ${label.dacGuia ?? 'n/a'}\n\n` +
        `Se borrará el registro de esta etiqueta y la orden se volverá a ` +
        `procesar en la próxima corrida del worker. La guía DAC anterior ` +
        `no se cancela automáticamente — si querés anularla, hacelo desde el ` +
        `panel de DAC antes de continuar.`,
    );
    if (!confirmed) return;

    setRedoing(label.id);
    try {
      const res = await fetch(`/api/v1/labels/${label.id}/redo`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        alert(body?.error ?? 'No se pudo reenviar la etiqueta');
        return;
      }
      await fetchData();
    } catch {
      alert('Error de conexión al reenviar la etiqueta');
    } finally {
      setRedoing(null);
    }
  };

  // Group labels by date
  const grouped = labels.reduce<Record<string, LabelFile[]>>((acc, label) => {
    const date = new Date(label.createdAt).toLocaleDateString('es-UY', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    if (!acc[date]) acc[date] = [];
    acc[date].push(label);
    return acc;
  }, {});

  return (
    <>
    <div className={cn('animate-fade-in', selectedIds.size > 0 && 'pb-24')}>
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4 text-cyan-400" />
            <span className="text-[11px] font-medium text-cyan-400 uppercase tracking-wider">Archivos</span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">Etiquetas PDF</h1>
            {selectedIds.size > 0 && (
              <span className="px-2 py-0.5 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-xs font-medium text-cyan-400">
                {selectedIds.size} seleccionada{selectedIds.size !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <p className="text-zinc-500 text-sm mt-0.5">{total} etiquetas descargables</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por guia o pedido..."
              className="pl-10 pr-4 py-2 w-56 bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 transition-all"
            />
          </div>
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="px-3 py-2 bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-zinc-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 [color-scheme:dark]"
          />
          <button
            onClick={fetchData}
            className="p-2 bg-white/[0.03] border border-white/[0.06] rounded-xl text-zinc-500 hover:text-cyan-400 hover:border-cyan-500/30 transition-all"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="glass rounded-xl p-4 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Etiquetas disponibles</p>
            <p className="text-xl font-bold text-white mt-1">{total}</p>
          </div>
          <Download className="w-5 h-5 text-cyan-400" />
        </div>
      </div>

      {/* Labels grouped by date */}
      {loading ? (
        <div className="text-center py-20">
          <RefreshCw className="w-6 h-6 text-zinc-700 mx-auto mb-3 animate-spin" />
          <p className="text-zinc-600 text-sm">Cargando etiquetas...</p>
        </div>
      ) : labels.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4">
            <FolderOpen className="w-7 h-7 text-zinc-700" />
          </div>
          <p className="text-zinc-400 text-sm font-medium">Sin etiquetas generadas</p>
          <p className="text-zinc-600 text-xs mt-1">Las etiquetas aparecen aca cuando el agente procesa pedidos</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([date, items]) => {
            const selectableIds = items.filter((l) => l.pdfPath).map((l) => l.id);
            const groupState = getGroupState(selectableIds);

            return (
              <div key={date}>
                <div className="flex items-center gap-2 mb-3">
                  {/* Group select checkbox */}
                  <button
                    onClick={() => toggleSelectGroup(selectableIds)}
                    className={cn(
                      'w-5 h-5 rounded-md border flex items-center justify-center transition-all flex-shrink-0',
                      groupState === 'all'
                        ? 'bg-cyan-500 border-cyan-500'
                        : groupState === 'some'
                          ? 'bg-cyan-500/30 border-cyan-500/50'
                          : 'border-white/10 hover:border-white/20'
                    )}
                  >
                    {groupState === 'all' && <Check className="w-3 h-3 text-white" />}
                    {groupState === 'some' && <Minus className="w-3 h-3 text-cyan-300" />}
                  </button>
                  <Calendar className="w-3.5 h-3.5 text-zinc-600" />
                  <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide capitalize">{date}</h3>
                  <span className="text-[10px] text-zinc-700 bg-white/[0.03] px-1.5 py-0.5 rounded">{items.length}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {items.map((label, i) => {
                    const isSelected = selectedIds.has(label.id);
                    const hasPdf = !!label.pdfPath;

                    return (
                      <div
                        key={label.id}
                        className={cn(
                          'glass rounded-xl p-4 group transition-all duration-200 cursor-pointer',
                          isSelected
                            ? 'border-cyan-500/30 bg-cyan-500/[0.03]'
                            : 'hover:border-cyan-500/20',
                          `animate-fade-in-up delay-${Math.min(i * 50, 200)}`
                        )}
                        onClick={(e) => {
                          // Don't toggle when clicking buttons or links
                          const target = e.target as HTMLElement;
                          if (target.closest('a') || target.closest('button')) return;
                          if (hasPdf) toggleSelect(label.id);
                        }}
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-cyan-500/10">
                              <FileText className="w-4 h-4 text-cyan-400" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-white">{label.shopifyOrderName}</p>
                              <p className="text-[11px] text-zinc-500">{label.customerName}</p>
                            </div>
                          </div>
                          {/* Checkbox */}
                          {hasPdf ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSelect(label.id);
                              }}
                              className={cn(
                                'w-5 h-5 rounded-md border flex items-center justify-center transition-all flex-shrink-0',
                                isSelected
                                  ? 'bg-cyan-500 border-cyan-500'
                                  : 'border-white/10 hover:border-white/20'
                              )}
                            >
                              {isSelected && <Check className="w-3 h-3 text-white" />}
                            </button>
                          ) : (
                            <Clock className="w-4 h-4 text-zinc-600" />
                          )}
                        </div>

                        <div className="flex items-center gap-3 mb-3 text-[11px] text-zinc-500">
                          {label.dacGuia && (
                            <span className="font-mono text-cyan-400/80">DAC-{label.dacGuia}</span>
                          )}
                          <span>{label.city}</span>
                        </div>

                        {label.pdfPath ? (
                          <div className="flex items-center gap-2">
                            <a
                              href={`/api/v1/labels/${label.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-center gap-2 flex-1 py-2 rounded-lg bg-cyan-600/10 border border-cyan-500/20 text-cyan-400 text-xs font-medium hover:bg-cyan-600/20 transition-colors"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Descargar
                            </a>
                            <PrintButton labelId={label.id} pdfPath={label.pdfPath} size="md" />
                            <button
                              type="button"
                              title="Reenviar: borra este registro para que el worker vuelva a procesar la orden"
                              disabled={redoing === label.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleRedo(label);
                              }}
                              className={cn(
                                'flex items-center justify-center w-9 h-9 rounded-lg border text-xs font-medium transition-colors',
                                redoing === label.id
                                  ? 'bg-amber-500/10 border-amber-500/20 text-amber-300 cursor-wait'
                                  : 'bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 hover:bg-amber-500/5',
                              )}
                            >
                              <RotateCcw className={cn('w-3.5 h-3.5', redoing === label.id && 'animate-spin')} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-zinc-500/5 border border-white/[0.04] text-zinc-600 text-xs">
                            <Clock className="w-3.5 h-3.5" />
                            PDF no disponible
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>

    {/* Bulk action bar — outside animate-fade-in to avoid transform breaking fixed positioning */}
    <BulkActionBar
      selectedCount={selectedIds.size}
      onPrint={() => handleBulk('print')}
      onDownload={() => handleBulk('download')}
      onClear={() => setSelectedIds(new Set())}
      loading={bulkLoading}
    />
    </>
  );
}
