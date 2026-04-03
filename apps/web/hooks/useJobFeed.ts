'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { buildOrderTracks, type OrderTrack } from '@/lib/log-messages';

export interface FeedLog {
  id: string;
  createdAt: string;
  level: string;
  message: string;
  meta: Record<string, unknown>;
}

export interface ActiveJob {
  id: string;
  status: string;
  createdAt: string;
  totalOrders: number;
  successCount: number;
  failedCount: number;
}

export function useJobFeed(activeJobId: string | null) {
  const [logs, setLogs] = useState<FeedLog[]>([]);
  const [job, setJob] = useState<ActiveJob | null>(null);
  const [lastSince, setLastSince] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!activeJobId) return;
    const params = new URLSearchParams({ jobId: activeJobId, limit: '200' });
    if (lastSince) params.set('since', lastSince);

    const res = await fetch(`/api/v1/logs?${params}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.logs?.length > 0) {
      setLogs((prev) => {
        const existingIds = new Set(prev.map((l: FeedLog) => l.id));
        const newLogs = data.logs.filter((l: FeedLog) => !existingIds.has(l.id));
        return [...prev, ...newLogs];
      });
      const last = data.logs[data.logs.length - 1];
      setLastSince(last.createdAt);
    }

    if (data.activeJob) setJob(data.activeJob);
  }, [activeJobId, lastSince]);

  useEffect(() => {
    if (!activeJobId) return;
    setLogs([]);
    setLastSince(null);

    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId]);

  const isRunning = job?.status === 'RUNNING' || job?.status === 'PENDING';

  // Build order tracking from logs
  const orderTracks = useMemo(() => buildOrderTracks(logs), [logs]);

  return { logs, job, isRunning, orderTracks };
}
