'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  FileText,
  Download,
  Calendar,
  Search,
  RefreshCw,
  FolderOpen,
  CheckCircle,
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

  const fetchData = useCallback(async () => {
    setLoading(true);
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

  // Group labels by date
  const grouped = labels.reduce<Record<string, LabelFile[]>>((acc, label) => {
    const date = new Date(label.createdAt).toLocaleDateString('es-UY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!acc[date]) acc[date] = [];
    acc[date].push(label);
    return acc;
  }, {});

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4 text-cyan-400" />
            <span className="text-[11px] font-medium text-cyan-400 uppercase tracking-wider">Archivos</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Etiquetas PDF</h1>
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
          {Object.entries(grouped).map(([date, items]) => (
            <div key={date}>
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="w-3.5 h-3.5 text-zinc-600" />
                <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide capitalize">{date}</h3>
                <span className="text-[10px] text-zinc-700 bg-white/[0.03] px-1.5 py-0.5 rounded">{items.length}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {items.map((label, i) => (
                  <div
                    key={label.id}
                    className={cn(
                      'glass rounded-xl p-4 group hover:border-cyan-500/20 transition-all duration-200',
                      `animate-fade-in-up delay-${Math.min(i * 50, 200)}`
                    )}
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
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                    </div>

                    <div className="flex items-center gap-3 mb-3 text-[11px] text-zinc-500">
                      {label.dacGuia && (
                        <span className="font-mono text-cyan-400/80">DAC-{label.dacGuia}</span>
                      )}
                      <span>{label.city}</span>
                    </div>

                    <a
                      href={`/api/v1/labels/${label.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-cyan-600/10 border border-cyan-500/20 text-cyan-400 text-xs font-medium hover:bg-cyan-600/20 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Descargar PDF
                    </a>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
