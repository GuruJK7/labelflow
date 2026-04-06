'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  CheckCircle, XCircle, Clock, AlertTriangle, Loader2,
  RefreshCw, Play, Terminal, Beaker, ArrowDown,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface RunLog {
  id: string;
  level: string;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
  jobId: string | null;
}

interface ActiveJob {
  id: string;
  status: string;
  trigger: string;
  totalOrders: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

const LEVEL_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
  INFO: { icon: '>', color: 'text-zinc-400', bg: 'bg-zinc-500/5' },
  SUCCESS: { icon: 'OK', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  WARN: { icon: '!!', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  ERROR: { icon: 'ERR', color: 'text-red-400', bg: 'bg-red-500/10' },
  DEBUG: { icon: '..', color: 'text-zinc-600', bg: 'bg-zinc-500/5' },
  STEP: { icon: '>>', color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  COMPLETED: { label: 'Completado', color: 'text-emerald-400', icon: CheckCircle },
  RUNNING: { label: 'Ejecutando...', color: 'text-cyan-400', icon: Loader2 },
  PENDING: { label: 'En cola', color: 'text-zinc-400', icon: Clock },
  FAILED: { label: 'Error', color: 'text-red-400', icon: XCircle },
  PARTIAL: { label: 'Parcial', color: 'text-amber-400', icon: AlertTriangle },
};

export default function LogsPage() {
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [testRunning, setTestRunning] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [orderCount, setOrderCount] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const lastFetchRef = useRef<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const url = new URL('/api/v1/logs', window.location.origin);
      url.searchParams.set('limit', '300');

      const res = await fetch(url.toString());
      if (!res.ok) return;

      const { data } = await res.json();
      if (data) {
        setLogs(data.logs ?? []);
        setActiveJob(data.activeJob ?? null);
      }
    } catch {
      // silent
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const handleRun = async () => {
    setTestRunning(true);
    try {
      const res = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxOrders: orderCount }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Error al crear job');
      }
    } catch {
      setError('Error de conexion');
    }
    setTestRunning(false);
  };

  const formatTime = (d: string) =>
    new Date(d).toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const isRunning = activeJob?.status === 'RUNNING' || activeJob?.status === 'PENDING';
  const statusCfg = STATUS_CONFIG[activeJob?.status ?? 'PENDING'] ?? STATUS_CONFIG.PENDING;
  const StatusIcon = statusCfg.icon;

  // Extract step progress from logs
  const stepProgress = {
    shopify: logs.some(l => l.message.includes('shopify') || l.message.includes('Shopify') || l.message.includes('orders found')),
    login: logs.some(l => l.message.includes('login') && l.level === 'SUCCESS'),
    form: logs.some(l => l.message.includes('Step') || l.message.includes('step') || l.message.includes('form')),
    guia: logs.some(l => l.message.includes('guia') || l.message.includes('Guia')),
    saved: logs.some(l => l.message.includes('processed') || l.message.includes('saved') || l.message.includes('Label')),
  };

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100vh-80px)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Terminal className="w-4 h-4 text-cyan-400" />
            <span className="text-[11px] font-medium text-cyan-400 uppercase tracking-wider">Monitor</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Logs en tiempo real</h1>
          <p className="text-zinc-500 text-xs mt-0.5">Polling cada 2s -- {logs.length} entradas</p>
        </div>
        <button
          onClick={fetchLogs}
          className="p-2 bg-white/[0.03] border border-white/[0.06] rounded-lg text-zinc-500 hover:text-cyan-400 transition-all"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Order count selector + run button */}
      <div className="flex items-center gap-3 mb-4 flex-shrink-0">
        <span className="text-xs text-zinc-500">Cantidad de pedidos:</span>
        <div className="flex items-center gap-1.5">
          {[1, 3, 5, 10, 20].map((n) => (
            <button
              key={n}
              onClick={() => setOrderCount(n)}
              disabled={isRunning}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                orderCount === n
                  ? 'bg-cyan-600 border-cyan-500 text-white'
                  : 'bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:text-white hover:border-white/[0.12]'
              )}
            >
              {n}
            </button>
          ))}
        </div>
        <button
          onClick={handleRun}
          disabled={testRunning || isRunning}
          className="flex items-center gap-2 px-5 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all ml-2"
        >
          {testRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Ejecutar {orderCount === 1 ? '1 pedido' : `${orderCount} pedidos`}
        </button>
      </div>

      {/* Error toast */}
      {error && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-xl mb-3 border border-red-500/20 bg-red-500/5 flex-shrink-0">
          <span className="text-sm text-red-400">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300 text-xs ml-4">Cerrar</button>
        </div>
      )}

      {/* Active job status bar */}
      {activeJob && (
        <div className={cn(
          'flex items-center justify-between px-4 py-2.5 rounded-xl mb-3 border flex-shrink-0',
          isRunning ? 'bg-cyan-500/5 border-cyan-500/20' : activeJob.status === 'COMPLETED' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'
        )}>
          <div className="flex items-center gap-3">
            <StatusIcon className={cn('w-4 h-4', statusCfg.color, isRunning && 'animate-spin')} />
            <span className={cn('text-xs font-medium', statusCfg.color)}>{statusCfg.label}</span>
            <span className="text-[10px] text-zinc-600">Job {activeJob.id.substring(0, 8)}</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-zinc-500">
            <span>Pedidos: {
              activeJob.totalOrders > 0
                ? activeJob.totalOrders
                : logs.filter(l => l.jobId === activeJob.id && (l.message.includes('order-start') || l.message.includes('Processing order') || l.message.includes('order 1/'))).length || 0
            }</span>
            <span className="text-emerald-400">OK: {
              activeJob.successCount > 0
                ? activeJob.successCount
                : logs.filter(l => l.jobId === activeJob.id && l.level === 'SUCCESS' && (l.message.includes('processed successfully') || l.message.includes('order-complete'))).length
            }</span>
            <span className="text-red-400">Err: {
              activeJob.failedCount > 0
                ? activeJob.failedCount
                : logs.filter(l => l.jobId === activeJob.id && l.level === 'ERROR' && l.message.includes('order-fail')).length
            }</span>
            {activeJob.durationMs ? (
              <span className="font-mono">{Math.round(activeJob.durationMs / 1000)}s</span>
            ) : activeJob.startedAt ? (
              <span className="font-mono">{Math.round((Date.now() - new Date(activeJob.startedAt).getTime()) / 1000)}s</span>
            ) : null}
          </div>
        </div>
      )}

      {/* Live indicator */}
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-[10px] text-zinc-600">En vivo</span>
        </div>
        <button
          onClick={() => setAutoScroll(!autoScroll)}
          className={cn(
            'flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-all',
            autoScroll ? 'text-cyan-400 bg-cyan-500/10' : 'text-zinc-600 bg-white/[0.02]'
          )}
        >
          <ArrowDown className="w-3 h-3" />
          Auto-scroll {autoScroll ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Log feed - terminal style */}
      <div className="flex-1 overflow-y-auto bg-[#050505] rounded-xl border border-white/[0.04] font-mono text-[11px] p-3 space-y-0.5">
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Terminal className="w-8 h-8 text-zinc-800 mx-auto mb-2" />
              <p className="text-zinc-700 text-xs">Sin logs. Ejecuta un test para ver actividad.</p>
            </div>
          </div>
        ) : (
          logs.map((log) => {
            const style = LEVEL_STYLES[log.level] ?? LEVEL_STYLES.INFO;
            const meta = log.meta;
            const step = meta?.step as string | undefined;
            const durationMs = meta?.durationMs as number | undefined;

            return (
              <div key={log.id} className="flex items-start gap-1.5 py-0.5 hover:bg-white/[0.01] px-1 rounded">
                <span className="text-zinc-700 flex-shrink-0 w-[60px]">
                  {formatTime(log.createdAt)}
                </span>
                <span className={cn('flex-shrink-0 w-[32px] text-center rounded px-0.5', style.bg, style.color)}>
                  {style.icon}
                </span>
                <span className={cn('flex-1 break-all', style.color)}>
                  {log.message}
                </span>
                {step && (
                  <span className="text-zinc-700 flex-shrink-0 text-[9px]">[{step}]</span>
                )}
                {durationMs !== undefined && durationMs > 0 && (
                  <span className="text-zinc-700 flex-shrink-0 text-[9px]">+{durationMs}ms</span>
                )}
              </div>
            );
          })
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
