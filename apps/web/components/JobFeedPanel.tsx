'use client';
import { useEffect, useRef, useState } from 'react';
import { useJobFeed, FeedLog } from '@/hooks/useJobFeed';
import { getDisplayMessage, type OrderTrack } from '@/lib/log-messages';

interface Props {
  jobId: string | null;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Elapsed timer                                                      */
/* ------------------------------------------------------------------ */
function ElapsedTimer({ startTime }: { startTime: string | number }) {
  const [elapsed, setElapsed] = useState('00:00');
  useEffect(() => {
    const start =
      typeof startTime === 'number' ? startTime : new Date(startTime).getTime();
    const tick = () => {
      const diff = Math.floor((Date.now() - start) / 1000);
      const m = Math.floor(diff / 60)
        .toString()
        .padStart(2, '0');
      const s = (diff % 60).toString().padStart(2, '0');
      setElapsed(`${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startTime]);
  return (
    <span className="text-zinc-500 font-mono text-xs tabular-nums">
      {elapsed}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Status dot (6 px colored circle)                                   */
/* ------------------------------------------------------------------ */
function StatusDot({
  color,
  pulse = false,
}: {
  color: 'green' | 'cyan' | 'red' | 'gray';
  pulse?: boolean;
}) {
  const base = 'inline-block w-1.5 h-1.5 rounded-full flex-shrink-0';
  const colors: Record<string, string> = {
    green: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]',
    cyan: 'bg-cyan-400 shadow-[0_0_6px_rgba(6,182,212,0.5)]',
    red: 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.5)]',
    gray: 'bg-zinc-600',
  };
  return (
    <span
      className={`${base} ${colors[color]} ${pulse ? 'animate-[pulseDot_1.2s_ease-in-out_infinite]' : ''}`}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Single order row                                                   */
/* ------------------------------------------------------------------ */
function OrderRow({
  order,
  isRunning,
  isLast,
}: {
  order: OrderTrack;
  isRunning: boolean;
  isLast: boolean;
}) {
  const isCompleted = order.status === 'completed';
  const isFailed = order.status === 'failed';
  const isProcessing = order.status === 'processing';
  const isQueued = order.status === 'queued';

  const dotColor = isCompleted
    ? 'green'
    : isFailed
      ? 'red'
      : isProcessing
        ? 'cyan'
        : 'gray';

  const nameColor = isCompleted || isFailed
    ? 'text-zinc-500'
    : isProcessing
      ? 'text-zinc-200'
      : 'text-zinc-600';

  const detailColor = isCompleted || isFailed
    ? 'text-zinc-600'
    : isProcessing
      ? 'text-zinc-400'
      : 'text-zinc-700';

  const address =
    order.address && order.city
      ? `${order.address}, ${order.city}`
      : order.address || order.city || '';

  return (
    <div
      className={`animate-[fadeRowIn_0.3s_ease_forwards] opacity-0 ${!isLast ? 'border-b border-white/[0.04]' : ''}`}
    >
      <div className="flex items-start gap-3 py-3 px-4">
        {/* Dot */}
        <div className="pt-[5px]">
          <StatusDot color={dotColor as 'green' | 'cyan' | 'red' | 'gray'} pulse={isProcessing && isRunning} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Top line: order name + customer */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`text-xs font-semibold ${nameColor} truncate`}>
                {order.orderName}
              </span>
              {order.customerName && (
                <>
                  <span className="text-zinc-700 text-xs">·</span>
                  <span className={`text-xs ${nameColor} truncate`}>
                    {order.customerName}
                  </span>
                </>
              )}
            </div>
            <div className="flex-shrink-0 text-right">
              {order.duration != null && (
                <span className="text-zinc-600 font-mono text-[11px] tabular-nums">
                  {order.duration}s
                </span>
              )}
              {isProcessing && order.startTime && isRunning && (
                <ElapsedTimer startTime={order.startTime} />
              )}
              {isQueued && (
                <span className="text-zinc-700 text-[11px]">En cola</span>
              )}
            </div>
          </div>

          {/* Detail line: address + meta */}
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {address && (
              <span className={`text-[11px] ${detailColor} truncate`}>
                {address}
              </span>
            )}
            {isCompleted && (order.amount || order.paymentType || order.guia) && (
              <span className="text-[11px] text-zinc-600">
                {[
                  order.amount && `$${order.amount}`,
                  order.paymentType,
                  order.guia && `Guia: ${order.guia}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            {isProcessing && !order.guia && (
              <span className="text-[11px] text-cyan-700">
                Esperando guia DAC...
              </span>
            )}
            {isProcessing && order.guia && (
              <span className="text-[11px] text-cyan-600">
                Guia: {order.guia}
              </span>
            )}
            {isFailed && order.errorMessage && (
              <span className="text-[11px] text-red-400/70 truncate">
                {order.errorMessage}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Progress bar                                                       */
/* ------------------------------------------------------------------ */
function ProgressBar({
  completed,
  total,
}: {
  completed: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="w-full h-[3px] bg-white/[0.04] rounded-full overflow-hidden">
      <div
        className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-400 transition-all duration-700 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
export function JobFeedPanel({ jobId, onClose }: Props) {
  const { logs, job, isRunning, orderTracks } = useJobFeed(jobId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissed when a new job starts
  useEffect(() => {
    setDismissed(false);
  }, [jobId]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [orderTracks.length, logs.length]);

  // Nothing to show
  if (!jobId) return null;
  if (dismissed) return null;

  const visibleLogs = logs
    .map((log: FeedLog) => ({ log, msg: getDisplayMessage(log) }))
    .filter(({ msg }) => msg !== null);

  const hasOrders = orderTracks.length > 0;
  const completedCount = job
    ? job.successCount + job.failedCount
    : orderTracks.filter(
        (o) => o.status !== 'processing' && o.status !== 'queued'
      ).length;
  const failedCount = job?.failedCount ?? orderTracks.filter((o) => o.status === 'failed').length;
  const totalCount = job?.totalOrders || orderTracks.length;

  // Total duration for summary
  const totalDuration = orderTracks.reduce(
    (sum, o) => sum + (o.duration ?? 0),
    0
  );
  const durationStr =
    totalDuration >= 60
      ? `${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`
      : `${totalDuration}s`;

  /* ---- Completed summary (compact bar) ---- */
  if (!isRunning && job && hasOrders) {
    return (
      <div className="mb-6 animate-[fadeRowIn_0.3s_ease_forwards]">
        <div className="bg-[#0d1117] border border-white/[0.06] rounded-2xl px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <StatusDot color={failedCount > 0 ? 'red' : 'green'} />
            <span className="text-sm text-zinc-300">
              <span className="font-medium text-white">
                {job.successCount}
              </span>{' '}
              {job.successCount === 1 ? 'pedido procesado' : 'pedidos procesados'}
              {failedCount > 0 && (
                <>
                  {' · '}
                  <span className="text-red-400">{failedCount} {failedCount === 1 ? 'error' : 'errores'}</span>
                </>
              )}
              {' · '}
              <span className="text-zinc-500">{durationStr}</span>
            </span>
          </div>
          <button
            onClick={() => {
              setDismissed(true);
              onClose();
            }}
            className="text-zinc-600 hover:text-zinc-400 transition-colors p-1 rounded-lg hover:bg-white/[0.04]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>

        {/* Expandable logs link */}
        {visibleLogs.length > 0 && (
          <div className="mt-1.5 px-2">
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              {showLogs ? 'Ocultar' : 'Ver'} logs ({visibleLogs.length})
            </button>
            {showLogs && (
              <LogSection logs={visibleLogs} isRunning={false} />
            )}
          </div>
        )}
      </div>
    );
  }

  /* ---- Running state ---- */
  return (
    <div className="mb-6 bg-[#0d1117] border border-white/[0.06] rounded-2xl overflow-hidden animate-[fadeRowIn_0.3s_ease_forwards]">
      {/* Header bar */}
      <div className="flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-2.5">
          <StatusDot color="cyan" pulse />
          <span className="text-sm font-medium text-zinc-200">
            Procesando pedidos
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <span className="tabular-nums font-mono">
            <span className="text-cyan-400 font-semibold">{completedCount}</span>
            /{totalCount} completados
          </span>
          {job && <ElapsedTimer startTime={job.createdAt} />}
        </div>
      </div>

      {/* Progress bar */}
      <div className="px-5 pb-3">
        <ProgressBar completed={completedCount} total={totalCount} />
      </div>

      {/* Order rows */}
      <div className="max-h-[400px] overflow-y-auto">
        {!hasOrders && isRunning && (
          <div className="flex items-center gap-2 px-5 py-4">
            <span className="text-zinc-700 text-xs animate-pulse">
              Iniciando procesamiento...
            </span>
          </div>
        )}

        {orderTracks.map((order, i) => (
          <OrderRow
            key={order.orderName}
            order={order}
            isRunning={isRunning}
            isLast={i === orderTracks.length - 1}
          />
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Logs toggle */}
      {visibleLogs.length > 0 && (
        <div className="border-t border-white/[0.04] px-5 py-2">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            {showLogs ? 'Ocultar' : 'Ver'} logs detallados ({visibleLogs.length})
          </button>
        </div>
      )}

      {showLogs && <LogSection logs={visibleLogs} isRunning={isRunning} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Log section (collapsible)                                          */
/* ------------------------------------------------------------------ */
function LogSection({
  logs,
  isRunning,
}: {
  logs: { log: FeedLog; msg: string | null }[];
  isRunning: boolean;
}) {
  return (
    <div className="border-t border-white/[0.04] px-5 py-3 max-h-[200px] overflow-y-auto space-y-0.5">
      {logs.map(({ log, msg }) => {
        const ts = new Date(log.createdAt).toLocaleTimeString('es-UY', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        const isError = log.level === 'ERROR';
        return (
          <div key={log.id} className="flex gap-3 items-baseline text-[11px]">
            <span className="text-zinc-700 font-mono min-w-[60px] tabular-nums">
              {ts}
            </span>
            <span
              className={`${isError ? 'text-red-400/80' : 'text-zinc-500'} leading-relaxed`}
            >
              {msg}
            </span>
          </div>
        );
      })}
      {isRunning && (
        <div className="h-4 flex items-center">
          <span className="text-cyan-700 text-xs animate-pulse">|</span>
        </div>
      )}
    </div>
  );
}
