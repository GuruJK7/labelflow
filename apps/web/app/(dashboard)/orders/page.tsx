'use client';

import { useEffect, useState, useCallback } from 'react';
import { PrintButton } from '@/components/printing/PrintButton';
import { UploadPdfButton } from '@/components/labels/UploadPdfButton';
import {
  Package,
  Download,
  Search,
  CheckCircle,
  XCircle,
  Clock,
  Filter,
  Mail,
  MailX,
  MapPin,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Truck,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface Label {
  id: string;
  shopifyOrderName: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  deliveryAddress: string;
  dacGuia: string | null;
  status: string;
  errorMessage: string | null;
  paymentType: string;
  totalUyu: number;
  city: string;
  department: string;
  pdfPath: string | null;
  emailSent: boolean;
  createdAt: string;
}

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string; icon: typeof CheckCircle }> = {
  COMPLETED: { color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', label: 'Completado', icon: CheckCircle },
  CREATED: { color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/20', label: 'Creado', icon: Truck },
  FAILED: { color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', label: 'Error', icon: XCircle },
  PENDING: { color: 'text-zinc-400', bg: 'bg-zinc-500/10 border-zinc-500/20', label: 'Pendiente', icon: Clock },
  SKIPPED: { color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', label: 'Salteado', icon: Clock },
  NEEDS_REVIEW: { color: 'text-amber-300', bg: 'bg-amber-500/15 border-amber-400/30', label: 'Revisar', icon: AlertTriangle },
};

export default function OrdersPage() {
  const [labels, setLabels] = useState<Label[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const limit = 15;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit), status });
      if (search) params.set('search', search);
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
  }, [page, status, search]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalPages = Math.ceil(total / limit);

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('es-UY', { style: 'currency', currency: 'UYU', maximumFractionDigits: 0 }).format(amount);

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('es-UY', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Package className="w-4 h-4 text-cyan-400" />
            <span className="text-[11px] font-medium text-cyan-400 uppercase tracking-wider">Gestion</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Pedidos procesados</h1>
          <p className="text-zinc-500 text-sm mt-0.5">{total} etiquetas en total</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Buscar pedido, cliente..."
              className="pl-10 pr-4 py-2 w-64 bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all"
            />
          </div>

          {/* Filter */}
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600" />
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              className="pl-9 pr-8 py-2 appearance-none bg-white/[0.03] border border-white/[0.06] rounded-xl text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 cursor-pointer"
            >
              <option value="all">Todos</option>
              <option value="COMPLETED">Completados</option>
              <option value="NEEDS_REVIEW">Revisar</option>
              <option value="FAILED">Con error</option>
              <option value="CREATED">Creados (sin PDF)</option>
              <option value="PENDING">Pendientes</option>
              <option value="SKIPPED">Salteados</option>
            </select>
          </div>

          {/* Refresh */}
          <button
            onClick={fetchData}
            className="p-2 bg-white/[0.03] border border-white/[0.06] rounded-xl text-zinc-500 hover:text-cyan-400 hover:border-cyan-500/30 transition-all"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="glass rounded-2xl overflow-hidden">
        {loading && labels.length === 0 ? (
          <div className="text-center py-20">
            <RefreshCw className="w-6 h-6 text-zinc-700 mx-auto mb-3 animate-spin" />
            <p className="text-zinc-600 text-sm">Cargando pedidos...</p>
          </div>
        ) : labels.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4">
              <Package className="w-7 h-7 text-zinc-700" />
            </div>
            <p className="text-zinc-400 text-sm font-medium">Sin pedidos procesados</p>
            <p className="text-zinc-600 text-xs mt-1">Los pedidos apareceran aca cuando se procesen</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    {['Pedido', 'Cliente', 'Guia DAC', 'Estado', 'Pago', 'Monto', 'Ciudad', 'Fecha', ''].map((h) => (
                      <th key={h} className="text-left px-5 py-3.5 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {labels.map((label, i) => {
                    const cfg = STATUS_CONFIG[label.status] ?? STATUS_CONFIG.PENDING;
                    const StatusIcon = cfg.icon;
                    const isExpanded = expandedRow === label.id;
                    return (
                      <>
                        <tr
                          key={label.id}
                          onClick={() => setExpandedRow(isExpanded ? null : label.id)}
                          className={cn(
                            'border-b border-white/[0.03] cursor-pointer transition-all duration-150',
                            'hover:bg-white/[0.02]',
                            isExpanded && 'bg-white/[0.02]',
                            `animate-fade-in delay-${Math.min(i * 50, 300)}`
                          )}
                        >
                          <td className="px-5 py-3.5">
                            <span className="text-sm font-semibold text-white">{label.shopifyOrderName}</span>
                          </td>
                          <td className="px-5 py-3.5">
                            <div>
                              <p className="text-sm text-zinc-300">{label.customerName}</p>
                              {label.customerEmail && (
                                <p className="text-[11px] text-zinc-600 mt-0.5">{label.customerEmail}</p>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            {label.dacGuia ? (
                              <span className="font-mono text-sm text-cyan-400 font-medium tracking-wide">{label.dacGuia}</span>
                            ) : (
                              <span className="text-zinc-700 text-sm">-</span>
                            )}
                          </td>
                          <td className="px-5 py-3.5">
                            <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border', cfg.bg, cfg.color)}>
                              <StatusIcon className="w-3 h-3" />
                              {cfg.label}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <span className={cn(
                              'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full',
                              label.paymentType === 'REMITENTE'
                                ? 'text-cyan-400 bg-cyan-500/10'
                                : 'text-amber-400 bg-amber-500/10'
                            )}>
                              {label.paymentType === 'REMITENTE' ? 'Remitente' : 'Destinatario'}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <span className="text-sm text-zinc-300 font-medium tabular-nums">
                              {formatCurrency(label.totalUyu)}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-1.5">
                              <MapPin className="w-3 h-3 text-zinc-600" />
                              <span className="text-xs text-zinc-400">{label.city}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <div>
                              <p className="text-xs text-zinc-400">{formatDate(label.createdAt)}</p>
                              <p className="text-[10px] text-zinc-600">{formatTime(label.createdAt)}</p>
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2">
                              {label.emailSent && (
                                <Mail className="w-3.5 h-3.5 text-emerald-500/60" />
                              )}
                              {label.pdfPath ? (
                                <>
                                  <a
                                    href={`/api/v1/labels/${label.id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="p-1.5 rounded-lg hover:bg-cyan-500/10 text-cyan-400 hover:text-cyan-300 transition-colors"
                                    title="Descargar PDF"
                                  >
                                    <Download className="w-4 h-4" />
                                  </a>
                                  <span onClick={(e) => e.stopPropagation()}>
                                    <PrintButton labelId={label.id} pdfPath={label.pdfPath} />
                                  </span>
                                </>
                              ) : label.status === 'NEEDS_REVIEW' &&
                                  label.dacGuia &&
                                  !label.dacGuia.startsWith('PENDING-') ? (
                                <UploadPdfButton labelId={label.id} onSuccess={fetchData} />
                              ) : (
                                <span className="w-4" />
                              )}
                            </div>
                          </td>
                        </tr>
                        {/* Expanded detail row */}
                        {isExpanded && (
                          <tr key={`${label.id}-detail`} className="bg-white/[0.01]">
                            <td colSpan={9} className="px-5 py-4">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                                <div>
                                  <p className="text-zinc-600 mb-0.5">Direccion</p>
                                  <p className="text-zinc-300">{label.deliveryAddress}</p>
                                </div>
                                <div>
                                  <p className="text-zinc-600 mb-0.5">Departamento</p>
                                  <p className="text-zinc-300">{label.department}</p>
                                </div>
                                <div>
                                  <p className="text-zinc-600 mb-0.5">Telefono</p>
                                  <p className="text-zinc-300">{label.customerPhone ?? '-'}</p>
                                </div>
                                <div>
                                  <p className="text-zinc-600 mb-0.5">Email enviado</p>
                                  <p className={cn('flex items-center gap-1', label.emailSent ? 'text-emerald-400' : 'text-zinc-500')}>
                                    {label.emailSent ? <><Mail className="w-3 h-3" /> Si</> : <><MailX className="w-3 h-3" /> No</>}
                                  </p>
                                </div>
                              </div>
                              {label.errorMessage && (
                                <div className={cn(
                                  'mt-3 rounded-lg border px-3 py-2 flex items-start gap-2',
                                  label.status === 'NEEDS_REVIEW'
                                    ? 'border-amber-400/30 bg-amber-500/[0.06]'
                                    : 'border-red-400/30 bg-red-500/[0.05]',
                                )}>
                                  <AlertTriangle className={cn(
                                    'w-3.5 h-3.5 flex-shrink-0 mt-0.5',
                                    label.status === 'NEEDS_REVIEW' ? 'text-amber-400' : 'text-red-400',
                                  )} />
                                  <p className={cn(
                                    'text-[11px] leading-relaxed',
                                    label.status === 'NEEDS_REVIEW' ? 'text-amber-100' : 'text-red-200',
                                  )}>
                                    {label.errorMessage}
                                  </p>
                                </div>
                              )}
                              {label.dacGuia && !label.dacGuia.startsWith('PENDING-') && (
                                <a
                                  href={`https://www.dac.com.uy/envios/rastrear?guia=${label.dacGuia}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 mt-3 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  Rastrear en DAC
                                </a>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between px-5 py-3.5 border-t border-white/[0.06]">
              <p className="text-xs text-zinc-600">
                Mostrando {(page - 1) * limit + 1}-{Math.min(page * limit, total)} de {total}
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="p-1.5 rounded-lg border border-white/[0.06] text-zinc-500 hover:text-white hover:bg-white/[0.03] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const pageNum = i + 1;
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setPage(pageNum)}
                      className={cn(
                        'w-8 h-8 rounded-lg text-xs font-medium transition-all',
                        pageNum === page
                          ? 'bg-cyan-600 text-white'
                          : 'text-zinc-500 hover:text-white hover:bg-white/[0.03]'
                      )}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="p-1.5 rounded-lg border border-white/[0.06] text-zinc-500 hover:text-white hover:bg-white/[0.03] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
