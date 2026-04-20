'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Package,
  MapPin,
  Truck,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowRight,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface LabelInsight {
  id: string;
  shopifyOrderName: string;
  customerName: string;
  city: string;
  department: string;
  dacGuia: string | null;
  status: string;
  paymentType: string;
  totalUyu: number;
  emailSent: boolean;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActiveJob {
  id: string;
  status: string;
  totalOrders: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface LogEntry {
  id: string;
  level: string;
  message: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

interface InsightsData {
  activeJob: ActiveJob | null;
  activeLogs: LogEntry[];
  recentLabels: LabelInsight[];
  todayCount: number;
  weekCount: number;
}

const STATUS_MAP: Record<string, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> = {
  COMPLETED: { label: 'Completado', color: 'text-emerald-400', bg: 'bg-emerald-500/10', icon: CheckCircle2 },
  CREATED: { label: 'Creado', color: 'text-cyan-400', bg: 'bg-cyan-500/10', icon: Truck },
  PENDING: { label: 'Pendiente', color: 'text-zinc-400', bg: 'bg-zinc-500/10', icon: Clock },
  FAILED: { label: 'Error', color: 'text-red-400', bg: 'bg-red-500/10', icon: XCircle },
};

function getStepFromLog(log: LogEntry): { emoji: string; text: string } | null {
  const meta = log.meta as Record<string, unknown>;
  // Step can be in meta.step (new logger) or parsed from message "[step] ..."
  const step = (meta?.step as string | undefined) ?? log.message.match(/^\[([^\]]+)\]/)?.[1];
  const msg = log.message.replace(/^\[[^\]]+\]\s*/, '');

  if (step === 'dac-login' && msg.includes('successful')) return { emoji: '\u{1F513}', text: 'Login DAC exitoso' };
  if (step === 'dac-login' && msg.includes('Starting')) return { emoji: '\u{1F510}', text: 'Conectando a DAC...' };
  if (step === 'shopify' && msg.includes('Fetched')) return { emoji: '\u{1F6CD}\uFE0F', text: msg };
  if (step === 'order-start') return { emoji: '\u{1F4E6}', text: `Procesando ${meta?.orderName ?? ''} - ${meta?.customer ?? ''}` };
  if (step === 'order-payment') return { emoji: '\u{1F4B3}', text: `Pago: ${meta?.orderName ?? ''} -> ${msg.split(': ')[1] ?? ''}` };
  if (step === 'order-shipment') return { emoji: '\u2705', text: `DAC guia creada: ${meta?.guia ?? ''}` };
  if (step === 'order-db') return { emoji: '\u{1F4BE}', text: 'Guardado en base de datos' };
  if (step === 'order-pdf') return { emoji: '\u{1F4C4}', text: msg.includes('Downloading') ? 'Descargando PDF...' : msg };
  if (step === 'order-fulfill' && msg.includes('fulfilled')) return { emoji: '\u{1F680}', text: `RASTREO ENVIADO - ${meta?.guia ?? ''}` };
  if (step === 'order-fulfill' && msg.includes('Marking')) return { emoji: '\u{1F4E4}', text: 'Marcando como Preparado en Shopify...' };
  if (step === 'order-shopify') return { emoji: '\u{1F3F7}\uFE0F', text: 'Etiqueta Shopify actualizada' };
  if (step === 'order-complete') return { emoji: '\u{1F389}', text: `${meta?.orderName ?? 'Pedido'} completado` };
  if (step === 'complete') return { emoji: '\u{1F3C1}', text: msg };
  if (step === 'filter') return { emoji: '\u{1F50D}', text: msg };
  if (step === 'limit') return { emoji: '\u26A0\uFE0F', text: msg };
  if (step?.startsWith('nav:')) return { emoji: '\u{1F310}', text: 'Navegando formulario DAC...' };
  if (step?.startsWith('step1:') && msg.includes('complete')) return { emoji: '\u2705', text: 'Paso 1: tipo de envio OK' };
  if (step?.startsWith('step2:') && msg.includes('complete')) return { emoji: '\u2705', text: 'Paso 2: origen OK' };
  if (step?.startsWith('step3:') && msg.includes('complete')) return { emoji: '\u2705', text: 'Paso 3: destinatario OK' };
  if (step?.startsWith('step4:') && msg.includes('added')) return { emoji: '\u2705', text: 'Paso 4: paquete OK' };
  if (step?.startsWith('submit:') && msg.includes('Guia found')) return { emoji: '\u{1F4CB}', text: `Guia: ${meta?.guia ?? ''}` };
  if (log.level === 'ERROR') return { emoji: '\u274C', text: msg };
  if (log.level === 'WARN' && step) return { emoji: '\u26A0\uFE0F', text: msg.substring(0, 120) };

  return null;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'Ahora';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ShipmentInsights() {
  const [data, setData] = useState<InsightsData | null>(null);
  const [expanded, setExpanded] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const fetchInsights = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/insights');
      if (!res.ok) return;
      const json = await res.json();
      setData(json.data);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchInsights();
    const interval = setInterval(fetchInsights, 3000);
    return () => clearInterval(interval);
  }, [fetchInsights]);

  useEffect(() => {
    if (data?.activeJob?.status !== 'RUNNING') return;
    // Scroll ONLY the inner log container — NEVER the page. The previous
    // `scrollIntoView({ behavior: 'smooth' })` also scrolled window ancestors,
    // which is why every new log line yanked the whole page down.
    // Also: respect the user's position. If they scrolled up to read
    // something, don't pull them back to the bottom.
    const end = logsEndRef.current;
    const container = end?.parentElement;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 40) {
      container.scrollTop = container.scrollHeight;
    }
  }, [data?.activeLogs?.length, data?.activeJob?.status]);

  if (!data) return null;

  const isRunning = data.activeJob?.status === 'RUNNING' || data.activeJob?.status === 'PENDING';
  const hasLogs = (data.activeLogs ?? []).length > 0;
  const filteredLogs = (data.activeLogs ?? [])
    .map((log) => ({ log, step: getStepFromLog(log) }))
    .filter(({ step }) => step !== null);

  return (
    <div className="glass rounded-2xl overflow-hidden mb-8 animate-fade-in">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-6 py-4 flex items-center justify-between border-b border-white/[0.06] hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-8 h-8 rounded-xl flex items-center justify-center',
            isRunning ? 'bg-cyan-500/15' : 'bg-white/[0.04]'
          )}>
            {isRunning ? (
              <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin" />
            ) : (
              <Package className="w-4 h-4 text-zinc-400" />
            )}
          </div>
          <div className="text-left">
            <h2 className="text-sm font-semibold text-white">
              {isRunning ? 'Envio en progreso...' : 'Seguimiento de envios'}
            </h2>
            <p className="text-[11px] text-zinc-500">
              {data.todayCount} hoy &middot; {data.weekCount} esta semana &middot; Auto-refresh 3s
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isRunning && data.activeJob && (
            <span className="text-xs text-cyan-400 font-medium flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
              {data.activeJob.successCount}/{data.activeJob.totalOrders} completados
            </span>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-zinc-500" />
          ) : (
            <ChevronDown className="w-4 h-4 text-zinc-500" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="divide-y divide-white/[0.04]">
          {/* Live Logs (when job is running or just finished) */}
          {(isRunning || hasLogs) && filteredLogs.length > 0 && (
            <div className="px-6 py-4">
              <div className="flex items-center gap-2 mb-3">
                {isRunning ? (
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                )}
                <span className={cn(
                  'text-[11px] font-medium uppercase tracking-wider',
                  isRunning ? 'text-cyan-400' : 'text-emerald-400'
                )}>
                  {isRunning ? 'En vivo' : 'Ultimo procesamiento'}
                </span>
              </div>
              <div className="max-h-[260px] overflow-y-auto space-y-1 scrollbar-thin pr-1">
                {filteredLogs.map(({ log, step }) => {
                  const ts = new Date(log.createdAt).toLocaleTimeString('es-UY', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                  });
                  return (
                    <div
                      key={log.id}
                      className={cn(
                        'flex items-start gap-2.5 py-1.5 px-3 rounded-lg text-xs transition-colors',
                        log.level === 'ERROR' ? 'bg-red-500/5' : 'hover:bg-white/[0.02]',
                      )}
                    >
                      <span className="text-zinc-600 font-mono whitespace-nowrap mt-px">{ts}</span>
                      <span className="shrink-0">{step!.emoji}</span>
                      <span className={cn(
                        'text-zinc-300 leading-relaxed',
                        log.level === 'ERROR' && 'text-red-400',
                        log.level === 'SUCCESS' && 'text-emerald-400',
                      )}>
                        {step!.text}
                      </span>
                    </div>
                  );
                })}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}

          {/* Recent shipments timeline */}
          {data.recentLabels.length > 0 && (
            <div className="px-6 py-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Envios recientes</span>
                <a href="/labels" className="text-[11px] text-cyan-400/70 hover:text-cyan-400 transition-colors">
                  Ver todos &rarr;
                </a>
              </div>
              <div className="space-y-1">
                {data.recentLabels.slice(0, 8).map((label) => {
                  const cfg = STATUS_MAP[label.status] ?? STATUS_MAP.PENDING;
                  const StatusIcon = cfg.icon;
                  return (
                    <div
                      key={label.id}
                      className="flex items-center gap-3 py-2.5 px-3 rounded-xl hover:bg-white/[0.02] transition-colors group"
                    >
                      {/* Status icon */}
                      <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', cfg.bg)}>
                        <StatusIcon className={cn('w-3.5 h-3.5', cfg.color)} />
                      </div>

                      {/* Order info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">{label.shopifyOrderName}</span>
                          <span className="text-[11px] text-zinc-500">{label.customerName}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <MapPin className="w-3 h-3 text-zinc-600" />
                          <span className="text-[11px] text-zinc-500">{label.city}, {label.department}</span>
                          {label.dacGuia && (
                            <>
                              <ArrowRight className="w-3 h-3 text-zinc-700" />
                              <span className="text-[11px] font-mono text-cyan-400/80">{label.dacGuia}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Payment & status */}
                      <div className="text-right shrink-0">
                        <span className={cn(
                          'text-[10px] font-medium px-2 py-0.5 rounded-full',
                          label.paymentType === 'REMITENTE'
                            ? 'bg-violet-500/10 text-violet-400'
                            : 'bg-amber-500/10 text-amber-400',
                        )}>
                          {label.paymentType === 'REMITENTE' ? 'Pago tienda' : 'Pago destino'}
                        </span>
                        <p className="text-[10px] text-zinc-600 mt-1">{timeAgo(label.createdAt)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Empty state */}
          {data.recentLabels.length === 0 && !isRunning && (
            <div className="px-6 py-10 text-center">
              <Package className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">Sin envios recientes</p>
              <p className="text-[11px] text-zinc-700 mt-1">Los envios apareceran aqui al ejecutar pedidos</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
