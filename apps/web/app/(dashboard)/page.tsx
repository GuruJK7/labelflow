'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Tags,
  Calendar,
  TrendingUp,
  Clock,
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react';

interface StatsData {
  labelsToday: number;
  labelsMonth: number;
  successRate: number;
  lastRunAt: string | null;
}

interface JobSummary {
  id: string;
  status: string;
  trigger: string;
  totalOrders: number;
  successCount: number;
  failedCount: number;
  createdAt: string;
  durationMs: number | null;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    try {
      const [settingsRes, jobsRes] = await Promise.all([
        fetch('/api/v1/settings'),
        fetch('/api/v1/jobs'),
      ]);
      if (settingsRes.ok) {
        const { data } = await settingsRes.json();
        setStats({
          labelsToday: 0,
          labelsMonth: data.labelsThisMonth ?? 0,
          successRate: 0,
          lastRunAt: null,
        });
      }
      if (jobsRes.ok) {
        const { data } = await jobsRes.json();
        setJobs(data ?? []);
      }
    } catch {
      // Silently handle
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  async function handleTrigger() {
    setTriggering(true);
    setError('');
    try {
      const res = await fetch('/api/v1/jobs', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Error');
      await fetchData();
    } catch {
      setError('Error de conexion');
    }
    setTriggering(false);
  }

  const statusIcon = (status: string) => {
    if (status === 'COMPLETED') return <CheckCircle className="w-4 h-4 text-emerald-400" />;
    if (status === 'RUNNING' || status === 'PENDING') return <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />;
    if (status === 'PARTIAL') return <AlertTriangle className="w-4 h-4 text-amber-400" />;
    return <XCircle className="w-4 h-4 text-red-400" />;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-zinc-500 text-sm mt-1">Resumen de tu automatizacion</p>
        </div>
        <button
          onClick={handleTrigger}
          disabled={triggering}
          className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {triggering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Ejecutar ahora
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm mb-6">{error}</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard title="Etiquetas hoy" value={stats?.labelsToday ?? 0} icon={<Tags className="w-5 h-5 text-cyan-400" />} />
        <StatCard title="Este mes" value={stats?.labelsMonth ?? 0} icon={<Calendar className="w-5 h-5 text-emerald-400" />} />
        <StatCard title="Exito %" value={`${stats?.successRate ?? 0}%`} icon={<TrendingUp className="w-5 h-5 text-amber-400" />} />
        <StatCard title="Ultimo run" value={stats?.lastRunAt ? new Date(stats.lastRunAt).toLocaleTimeString('es-UY') : 'Nunca'} icon={<Clock className="w-5 h-5 text-purple-400" />} isText />
      </div>

      {/* Recent jobs */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white">Ultimas ejecuciones</h2>
        </div>
        {jobs.length === 0 ? (
          <div className="text-center py-12 text-zinc-600 text-sm">Sin ejecuciones todavia</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.04]">
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Estado</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Origen</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Exitosos</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Errores</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Duracion</th>
                <th className="text-left px-5 py-3 text-[11px] font-medium text-zinc-500 uppercase">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {jobs.slice(0, 5).map((job) => (
                <tr key={job.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="px-5 py-3">{statusIcon(job.status)}</td>
                  <td className="px-5 py-3 text-xs text-zinc-400 capitalize">{job.trigger.toLowerCase()}</td>
                  <td className="px-5 py-3 text-xs text-emerald-400">{job.successCount}</td>
                  <td className="px-5 py-3 text-xs text-red-400">{job.failedCount}</td>
                  <td className="px-5 py-3 text-xs text-zinc-500">{job.durationMs ? `${Math.round(job.durationMs / 1000)}s` : '-'}</td>
                  <td className="px-5 py-3 text-xs text-zinc-500">{new Date(job.createdAt).toLocaleString('es-UY')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatCard({ title, value, icon, isText }: { title: string; value: number | string; icon: React.ReactNode; isText?: boolean }) {
  return (
    <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-zinc-500 font-medium">{title}</p>
        {icon}
      </div>
      <p className={`${isText ? 'text-base' : 'text-2xl'} font-bold text-white`}>{value}</p>
    </div>
  );
}
