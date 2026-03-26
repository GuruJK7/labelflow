'use client';

import { useEffect, useState } from 'react';
import { Package, Download, Search, CheckCircle, XCircle, Clock } from 'lucide-react';

interface Label {
  id: string;
  shopifyOrderName: string;
  customerName: string;
  dacGuia: string | null;
  status: string;
  paymentType: string;
  totalUyu: number;
  city: string;
  pdfPath: string | null;
  emailSent: boolean;
  createdAt: string;
}

export default function OrdersPage() {
  const [labels, setLabels] = useState<Label[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch_() {
      setLoading(true);
      const params = new URLSearchParams({ page: String(page), limit: '20', status });
      const res = await fetch(`/api/v1/orders?${params}`);
      if (res.ok) {
        const { data, meta } = await res.json();
        setLabels(data ?? []);
        setTotal(meta?.total ?? 0);
      }
      setLoading(false);
    }
    fetch_();
  }, [page, status]);

  const statusBadge = (s: string) => {
    const map: Record<string, { bg: string; text: string; label: string }> = {
      COMPLETED: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: 'Completado' },
      CREATED: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', label: 'Creado' },
      FAILED: { bg: 'bg-red-500/10', text: 'text-red-400', label: 'Error' },
      PENDING: { bg: 'bg-zinc-500/10', text: 'text-zinc-400', label: 'Pendiente' },
      SKIPPED: { bg: 'bg-amber-500/10', text: 'text-amber-400', label: 'Salteado' },
    };
    const style = map[s] ?? map.PENDING;
    return (
      <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium ${style.bg} ${style.text}`}>
        {style.label}
      </span>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Pedidos procesados</h1>
          <p className="text-zinc-500 text-sm mt-1">{total} etiquetas en total</p>
        </div>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="bg-zinc-800/50 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
        >
          <option value="all">Todos</option>
          <option value="COMPLETED">Completados</option>
          <option value="FAILED">Con error</option>
          <option value="PENDING">Pendientes</option>
        </select>
      </div>

      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl overflow-hidden">
        {loading ? (
          <div className="text-center py-16 text-zinc-600 text-sm">Cargando...</div>
        ) : labels.length === 0 ? (
          <div className="text-center py-16">
            <Package className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
            <p className="text-zinc-500 text-sm">Sin pedidos procesados</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.04]">
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Pedido</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Cliente</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Guia DAC</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Estado</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Pago</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Monto</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Fecha</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">PDF</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((label) => (
                <tr key={label.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="px-5 py-3.5 text-sm font-medium text-white">{label.shopifyOrderName}</td>
                  <td className="px-5 py-3.5 text-sm text-zinc-400">{label.customerName}</td>
                  <td className="px-5 py-3.5 text-sm font-mono text-cyan-400">{label.dacGuia ?? '-'}</td>
                  <td className="px-5 py-3.5">{statusBadge(label.status)}</td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs ${label.paymentType === 'REMITENTE' ? 'text-cyan-400' : 'text-amber-400'}`}>
                      {label.paymentType === 'REMITENTE' ? 'Remitente' : 'Destinatario'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-zinc-400">${Math.round(label.totalUyu)}</td>
                  <td className="px-5 py-3.5 text-xs text-zinc-500">
                    {new Date(label.createdAt).toLocaleDateString('es-UY')}
                  </td>
                  <td className="px-5 py-3.5">
                    {label.pdfPath ? (
                      <a href={`/api/v1/labels/${label.id}`} target="_blank" rel="noopener noreferrer"
                        className="text-cyan-400 hover:text-cyan-300">
                        <Download className="w-4 h-4" />
                      </a>
                    ) : (
                      <span className="text-zinc-700">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {total > 20 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-white/[0.04]">
            <p className="text-xs text-zinc-500">{total} total</p>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="px-3 py-1.5 text-xs border border-white/[0.08] rounded-lg text-zinc-400 disabled:opacity-30 hover:bg-white/[0.03]">
                Anterior
              </button>
              <button onClick={() => setPage((p) => p + 1)} disabled={labels.length < 20}
                className="px-3 py-1.5 text-xs border border-white/[0.08] rounded-lg text-zinc-400 disabled:opacity-30 hover:bg-white/[0.03]">
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
