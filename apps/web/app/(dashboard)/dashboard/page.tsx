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
  Zap,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/cn';

interface StatsData {
  labelsToday: number;
  labelsMonth: number;
  successRate: number;
  lastRunAt: string | null;
  shopifyTokenSet: boolean;
  dacPasswordSet: boolean;
  emailPassSet: boolean;
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
  const [orderCount, setOrderCount] = useState(1);

  const fetchData = useCallback(async () => {
    try {
      const [settingsRes, jobsRes] = await Promise.all([
        fetch('/api/v1/settings'),
        fetch('/api/v1/jobs'),
      ]);
      let settingsData: Record<string, unknown> | null = null;
      if (settingsRes.ok) {
        const res = await settingsRes.json();
        settingsData = res.data;
      }
      let jobsData: JobSummary[] = [];
      if (jobsRes.ok) {
        const res = await jobsRes.json();
        jobsData = res.data ?? [];
      }
      setJobs(jobsData);

      // Calculate labelsToday from jobs created today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayJobs = jobsData.filter(
        (j) => new Date(j.createdAt) >= todayStart
      );
      const labelsToday = todayJobs.reduce((sum, j) => sum + j.successCount, 0);

      // Calculate success rate from all jobs
      const totalOrders = jobsData.reduce((sum, j) => sum + j.totalOrders, 0);
      const totalSuccess = jobsData.reduce((sum, j) => sum + j.successCount, 0);
      const successRate = totalOrders > 0 ? Math.round((totalSuccess / totalOrders) * 100) : 0;

      setStats({
        labelsToday,
        labelsMonth: (settingsData?.labelsThisMonth as number) ?? 0,
        successRate,
        lastRunAt: (settingsData?.lastRunAt as string) ?? null,
        shopifyTokenSet: !!(settingsData?.shopifyTokenSet),
        dacPasswordSet: !!(settingsData?.dacPasswordSet),
        emailPassSet: !!(settingsData?.emailPassSet),
      });
    } catch {
      // Silent
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
      const res = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxOrders: orderCount }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Error');
      else window.location.href = '/logs';
      await fetchData();
    } catch {
      setError('Error de conexion');
    }
    setTriggering(false);
  }

  const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; bg: string; label: string }> = {
    COMPLETED: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'Completado' },
    RUNNING: { icon: Loader2, color: 'text-cyan-400', bg: 'bg-cyan-500/10', label: 'Ejecutando' },
    PENDING: { icon: Clock, color: 'text-zinc-400', bg: 'bg-zinc-500/10', label: 'Pendiente' },
    PARTIAL: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/10', label: 'Parcial' },
    FAILED: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', label: 'Error' },
  };

  const statCards = [
    {
      title: 'Etiquetas hoy',
      value: stats?.labelsToday ?? 0,
      icon: Tags,
      color: 'from-cyan-500/20 to-cyan-500/5',
      iconColor: 'text-cyan-400',
    },
    {
      title: 'Este mes',
      value: stats?.labelsMonth ?? 0,
      icon: Calendar,
      color: 'from-emerald-500/20 to-emerald-500/5',
      iconColor: 'text-emerald-400',
    },
    {
      title: 'Tasa de exito',
      value: `${stats?.successRate ?? 0}%`,
      icon: TrendingUp,
      color: 'from-violet-500/20 to-violet-500/5',
      iconColor: 'text-violet-400',
    },
    {
      title: 'Ultimo run',
      value: stats?.lastRunAt ? timeAgo(stats.lastRunAt) : 'Nunca',
      icon: Clock,
      color: 'from-amber-500/20 to-amber-500/5',
      iconColor: 'text-amber-400',
      isText: true,
    },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div className="animate-fade-in">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-4 h-4 text-cyan-400" />
            <span className="text-[11px] font-medium text-cyan-400 uppercase tracking-wider">Panel de control</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        </div>
        <div className="flex items-center gap-3 animate-fade-in delay-150">
          <div className="flex items-center gap-1.5">
            {[1, 3, 5, 10, 20].map((n) => (
              <button
                key={n}
                onClick={() => setOrderCount(n)}
                disabled={triggering}
                className={cn(
                  'w-9 h-9 rounded-lg text-xs font-semibold transition-all border',
                  orderCount === n
                    ? 'bg-cyan-600 border-cyan-500 text-white shadow-lg shadow-cyan-500/20'
                    : 'bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:text-white hover:border-white/[0.15]'
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            onClick={handleTrigger}
            disabled={triggering}
            className={cn(
              'inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-all duration-200',
              'bg-gradient-to-r from-cyan-600 to-cyan-500 text-white',
              'hover:from-cyan-500 hover:to-cyan-400 hover:shadow-lg hover:shadow-cyan-500/25',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {triggering ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            Ejecutar {orderCount === 1 ? '1 pedido' : `${orderCount} pedidos`}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm mb-6 animate-fade-in flex items-center gap-2">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {statCards.map((card, i) => (
          <div
            key={card.title}
            className={cn(
              'glass rounded-2xl p-5 relative overflow-hidden animate-fade-in-up',
              i === 0 && 'delay-75',
              i === 1 && 'delay-150',
              i === 2 && 'delay-225',
              i === 3 && 'delay-300',
            )}
          >
            {/* Gradient glow */}
            <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl ${card.color} rounded-full blur-2xl -translate-y-8 translate-x-8`} />

            <div className="relative">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{card.title}</p>
                <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center bg-white/[0.04]', card.iconColor)}>
                  <card.icon className="w-[18px] h-[18px]" />
                </div>
              </div>
              <div className="flex items-end justify-between">
                <p className={cn('font-bold text-white', card.isText ? 'text-lg' : 'text-3xl animate-count-up')}>
                  {card.value}
                </p>
{}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Connection Status */}
      <div className="glass rounded-2xl p-4 mb-8 animate-fade-in delay-300">
        <div className="flex flex-wrap items-center gap-6">
          <span className="text-xs font-medium text-zinc-500">Conexiones:</span>
          <div className="flex items-center gap-2">
            <span className={`status-dot ${stats?.shopifyTokenSet ? 'active' : ''}`} />
            <span className="text-xs text-zinc-400">Shopify</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`status-dot ${stats?.dacPasswordSet ? 'active' : ''}`} />
            <span className="text-xs text-zinc-400">DAC Uruguay</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`status-dot ${stats?.emailPassSet ? 'active' : ''}`} />
            <span className="text-xs text-zinc-400">Email SMTP</span>
          </div>
        </div>
      </div>

      {/* Recent jobs */}
      <div className="glass rounded-2xl overflow-hidden animate-fade-in-up delay-300">
        <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Zap className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-white">Ultimas ejecuciones</h2>
          </div>
          <span className="text-[11px] text-zinc-600">Auto-refresh 10s</span>
        </div>

        {jobs.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-12 h-12 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
              <Zap className="w-5 h-5 text-zinc-700" />
            </div>
            <p className="text-zinc-500 text-sm">Sin ejecuciones todavia</p>
            <p className="text-zinc-700 text-xs mt-1">Hace click en &quot;Ejecutar ahora&quot; para comenzar</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.04]">
                  {['Estado', 'Origen', 'Pedidos', 'Exitosos', 'Errores', 'Duracion', 'Fecha'].map((h) => (
                    <th key={h} className="text-left px-6 py-3 text-[11px] font-medium text-zinc-600 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 5).map((job, i) => {
                  const cfg = statusConfig[job.status] ?? statusConfig.FAILED;
                  const StatusIcon = cfg.icon;
                  return (
                    <tr key={job.id} className={cn('border-b border-white/[0.03] table-row-hover transition-colors animate-fade-in', `delay-${i * 75}`)}>
                      <td className="px-6 py-3.5">
                        <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full', cfg.bg, cfg.color)}>
                          <StatusIcon className={cn('w-3 h-3', job.status === 'RUNNING' && 'animate-spin')} />
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-6 py-3.5">
                        <span className="inline-flex items-center gap-1 text-xs text-zinc-400 bg-white/[0.03] px-2 py-0.5 rounded capitalize">
                          {job.trigger.toLowerCase()}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 text-sm text-zinc-300 font-medium">{job.totalOrders}</td>
                      <td className="px-6 py-3.5 text-sm text-emerald-400 font-medium">{job.successCount}</td>
                      <td className="px-6 py-3.5 text-sm font-medium">
                        <span className={job.failedCount > 0 ? 'text-red-400' : 'text-zinc-600'}>{job.failedCount}</span>
                      </td>
                      <td className="px-6 py-3.5 text-xs text-zinc-500 font-mono">
                        {job.durationMs ? formatDuration(job.durationMs) : '-'}
                      </td>
                      <td className="px-6 py-3.5 text-xs text-zinc-500">
                        {new Date(job.createdAt).toLocaleString('es-UY', {
                          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                        })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Ahora';
  if (mins < 60) return `Hace ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Hace ${hours}h`;
  return `Hace ${Math.floor(hours / 24)}d`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
