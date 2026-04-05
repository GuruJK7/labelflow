'use client';

import { useEffect, useState, useCallback } from 'react';
import { Flag, MessageSquare, HelpCircle, RefreshCw, Clock } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Report {
  id: string;
  tenantId: string;
  level: string;
  message: string;
  meta: {
    reportType: string;
    summary: string;
    conversation: string;
    reportedAt: string;
    tenantName?: string;
    shopifyStore?: string;
  } | null;
  createdAt: string;
}

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Report | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/chat/report');
      if (res.ok) {
        const { data } = await res.json();
        setReports(data ?? []);
      }
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  const typeConfig: Record<string, { icon: typeof Flag; color: string; bg: string; label: string }> = {
    bug: { icon: Flag, color: 'text-red-400', bg: 'bg-red-500/10', label: 'Bug' },
    feedback: { icon: MessageSquare, color: 'text-cyan-400', bg: 'bg-cyan-500/10', label: 'Feedback' },
    help: { icon: HelpCircle, color: 'text-amber-400', bg: 'bg-amber-500/10', label: 'Ayuda' },
  };

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Flag className="w-4 h-4 text-cyan-400" />
            <span className="text-[11px] font-medium text-cyan-400 uppercase tracking-wider">Soporte</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Reportes</h1>
          <p className="text-zinc-500 text-sm mt-0.5">{reports.length} reportes de usuarios</p>
        </div>
        <button
          onClick={fetchReports}
          className="p-2 bg-white/[0.03] border border-white/[0.06] rounded-xl text-zinc-500 hover:text-cyan-400 hover:border-cyan-500/30 transition-all"
        >
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </button>
      </div>

      {loading && reports.length === 0 ? (
        <div className="text-center py-20">
          <RefreshCw className="w-6 h-6 text-zinc-700 mx-auto mb-3 animate-spin" />
          <p className="text-zinc-600 text-sm">Cargando reportes...</p>
        </div>
      ) : reports.length === 0 ? (
        <div className="text-center py-20">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4">
            <Flag className="w-7 h-7 text-zinc-700" />
          </div>
          <p className="text-zinc-400 text-sm font-medium">Sin reportes</p>
          <p className="text-zinc-600 text-xs mt-1">Los reportes de bug y feedback del chat aparecen aca</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Reports list */}
          <div className="space-y-2">
            {reports.map((report) => {
              const rType = (report.meta?.reportType as string) ?? 'help';
              const cfg = typeConfig[rType] ?? typeConfig.help;
              const Icon = cfg.icon;
              const isSelected = selected?.id === report.id;

              return (
                <button
                  key={report.id}
                  onClick={() => setSelected(report)}
                  className={cn(
                    'w-full text-left glass rounded-xl p-4 transition-all duration-200',
                    isSelected
                      ? 'border-cyan-500/30 bg-cyan-500/5'
                      : 'hover:border-white/[0.1]'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', cfg.bg)}>
                      <Icon className={cn('w-4 h-4', cfg.color)} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full', cfg.bg, cfg.color)}>
                          {cfg.label}
                        </span>
                        <span className="text-[10px] text-zinc-600 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(report.createdAt).toLocaleString('es-UY', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-300 truncate">
                        {report.meta?.summary ?? report.message}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Detail panel */}
          <div className="glass rounded-xl p-5 sticky top-8">
            {selected ? (
              <div className="animate-fade-in">
                <div className="flex items-center gap-2 mb-4">
                  {(() => {
                    const rType = (selected.meta?.reportType as string) ?? 'help';
                    const cfg = typeConfig[rType] ?? typeConfig.help;
                    const Icon = cfg.icon;
                    return (
                      <>
                        <Icon className={cn('w-4 h-4', cfg.color)} />
                        <span className={cn('text-xs font-medium', cfg.color)}>{cfg.label}</span>
                        <span className="text-xs text-zinc-600 ml-auto">
                          {new Date(selected.createdAt).toLocaleString('es-UY')}
                        </span>
                      </>
                    );
                  })()}
                </div>

                {selected.meta?.tenantName && (
                  <div className="mb-4 bg-white/[0.03] rounded-lg px-3 py-2">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Tenant</p>
                    <p className="text-xs text-zinc-300">{selected.meta.tenantName} {selected.meta.shopifyStore ? `(${selected.meta.shopifyStore})` : ''}</p>
                  </div>
                )}

                <div className="mb-4">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-1">Resumen</p>
                  <p className="text-sm text-white">{selected.meta?.summary ?? selected.message}</p>
                </div>

                {selected.meta?.conversation && typeof selected.meta.conversation === 'string' && (
                  <div>
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-2">Conversacion</p>
                    <div className="space-y-2 max-h-[400px] overflow-y-auto text-xs">
                      {selected.meta.conversation.split('\n\n').map((block, i) => {
                        const isUser = block.startsWith('Usuario:');
                        const text = block.replace(/^(Usuario|Asistente):\s*/, '');
                        return (
                          <div key={i} className={cn(
                            'px-3 py-2 rounded-lg',
                            isUser ? 'bg-cyan-600/10 text-cyan-300' : 'bg-white/[0.03] text-zinc-400'
                          )}>
                            <p className="text-[9px] uppercase text-zinc-600 mb-0.5">{isUser ? 'Usuario' : 'Asistente'}</p>
                            <p className="whitespace-pre-wrap">{text}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-12">
                <p className="text-zinc-600 text-sm">Selecciona un reporte para ver los detalles</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
