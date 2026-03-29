'use client';
import { useEffect, useRef, useState } from 'react';
import { useJobFeed, FeedLog } from '@/hooks/useJobFeed';
import { getDisplayMessage } from '@/lib/log-messages';

interface Props {
  jobId: string | null;
  onClose: () => void;
}

function ElapsedTimer({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState('00:00:00');
  useEffect(() => {
    const start = new Date(startTime).getTime();
    const tick = () => {
      const diff = Math.floor((Date.now() - start) / 1000);
      const h = Math.floor(diff / 3600)
        .toString()
        .padStart(2, '0');
      const m = Math.floor((diff % 3600) / 60)
        .toString()
        .padStart(2, '0');
      const s = (diff % 60).toString().padStart(2, '0');
      setElapsed(`${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startTime]);
  return <span className="feed-elapsed">{elapsed}</span>;
}

export function JobFeedPanel({ jobId, onClose }: Props) {
  const { logs, job, isRunning } = useJobFeed(jobId);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll al ultimo log
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  if (!jobId) return null;

  // Filtrar solo los logs que tienen mensaje visible
  const visibleLogs = logs
    .map((log: FeedLog) => ({ log, msg: getDisplayMessage(log) }))
    .filter(({ msg }) => msg !== null);

  const shortId = jobId.slice(0, 6).toUpperCase();

  return (
    <div className="job-feed-panel">
      {/* Header */}
      <div className="feed-header">
        <div className="feed-header-left">
          <span
            className={`feed-status-dot ${isRunning ? 'pulse' : 'done'}`}
          />
          <span className="feed-title">
            {isRunning ? 'EJECUCION EN CURSO' : 'EJECUCION COMPLETADA'}
          </span>
          <span className="feed-job-id">&#8226; Job #{shortId}</span>
          {job && <ElapsedTimer startTime={job.createdAt} />}
        </div>
        <div className="feed-header-right">
          {job && (
            <span className="feed-stats">
              {job.successCount} ok &#183; {job.failedCount} err
            </span>
          )}
          <button className="feed-close" onClick={onClose}>
            &#10005;
          </button>
        </div>
      </div>

      {/* Feed */}
      <div className="feed-body">
        {visibleLogs.length === 0 && (
          <div className="feed-empty">
            <span className="feed-cursor-blink">&#9612;</span>
            <span style={{ marginLeft: 8, color: '#4a5568' }}>
              Iniciando...
            </span>
          </div>
        )}

        {visibleLogs.map(({ log, msg }, i) => {
          const ts = new Date(log.createdAt).toLocaleTimeString('es-UY', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          const isError = log.level === 'ERROR';
          const isSuccess = msg?.startsWith('\u2705');
          const isPending = msg?.startsWith('\u23F3');
          const isActive = msg?.startsWith('\u{1F504}') || msg?.startsWith('\u25B6');

          return (
            <div
              key={log.id}
              className={`feed-line feed-line-enter ${isError ? 'feed-error' : ''}`}
              style={{ animationDelay: `${Math.min(i * 30, 200)}ms` }}
            >
              <span className="feed-ts">{ts}</span>
              <span
                className={`feed-msg ${isSuccess ? 'feed-success' : ''} ${isActive ? 'feed-active' : ''} ${isPending ? 'feed-muted' : ''}`}
              >
                {msg}
                {(msg?.includes('...') || isActive) && isRunning && (
                  <span className="feed-dots-anim" />
                )}
              </span>
            </div>
          );
        })}

        {isRunning && (
          <div className="feed-cursor-line">
            <span className="feed-cursor-blink">&#9612;</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Footer cuando termina */}
      {!isRunning && job && (
        <div className="feed-footer">
          <span>
            {job.failedCount === 0
              ? `\u2705 ${job.successCount} envios creados en DAC`
              : `\u26A0\uFE0F ${job.successCount} exitosos \u00B7 ${job.failedCount} fallidos`}
          </span>
          <a href="/logs" className="feed-ver-logs">
            Ver logs completos &rarr;
          </a>
        </div>
      )}
    </div>
  );
}
