'use client';

import { useEffect, useState } from 'react';
import {
  Megaphone,
  Play,
  Pause,
  AlertCircle,
  CheckCircle2,
  Clock,
  Upload,
  Loader2,
  RefreshCw,
} from 'lucide-react';

interface AdStats {
  totalAds: number;
  activeAds: number;
  pausedAds: number;
  errorAds: number;
}

interface UploadJob {
  id: string;
  status: string;
  trigger: string;
  totalFiles: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export default function AdsPanel() {
  const [stats, setStats] = useState<AdStats>({ totalAds: 0, activeAds: 0, pausedAds: 0, errorAds: 0 });
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [adsRes, jobsRes] = await Promise.all([
        fetch('/api/ads/managed'),
        fetch('/api/ads/jobs'),
      ]);

      if (adsRes.ok) {
        const adsData = await adsRes.json();
        const ads = adsData.data?.ads || [];
        setStats({
          totalAds: ads.length,
          activeAds: ads.filter((a: { status: string }) => a.status === 'ACTIVE').length,
          pausedAds: ads.filter((a: { status: string }) => a.status === 'PAUSED' || a.status === 'PAUSED_AUTO').length,
          errorAds: ads.filter((a: { status: string }) => a.status === 'ERROR').length,
        });
      }

      if (jobsRes.ok) {
        const jobsData = await jobsRes.json();
        setJobs(jobsData.data?.jobs || []);
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const triggerScan = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/ads/scan', { method: 'POST' });
      if (res.ok) {
        // Poll for updates after a delay
        setTimeout(fetchData, 3000);
      }
    } catch {
      // Silent fail
    } finally {
      setScanning(false);
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'text-green-400';
      case 'RUNNING': return 'text-cyan-400';
      case 'PENDING': return 'text-yellow-400';
      case 'FAILED': return 'text-red-400';
      case 'PARTIAL': return 'text-orange-400';
      default: return 'text-zinc-500';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Anuncios', value: stats.totalAds, icon: Megaphone, color: 'text-cyan-400' },
          { label: 'Activos', value: stats.activeAds, icon: Play, color: 'text-green-400' },
          { label: 'Pausados', value: stats.pausedAds, icon: Pause, color: 'text-yellow-400' },
          { label: 'Con Error', value: stats.errorAds, icon: AlertCircle, color: 'text-red-400' },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-5"
          >
            <div className="flex items-center justify-between mb-3">
              <stat.icon className={`w-5 h-5 ${stat.color}`} />
            </div>
            <p className="text-2xl font-bold text-white">{stat.value}</p>
            <p className="text-xs text-zinc-500 mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={triggerScan}
          disabled={scanning}
          className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
        >
          {scanning ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          Escanear Drive y Subir
        </button>
        <button
          onClick={fetchData}
          className="inline-flex items-center gap-2 border border-white/[0.08] text-zinc-400 hover:text-white px-4 py-2.5 rounded-lg text-sm transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Actualizar
        </button>
      </div>

      {/* Job history */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white">Historial de Escaneos</h2>
        </div>
        {jobs.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <Clock className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
            <p className="text-sm text-zinc-500">No hay escaneos aun. Pulsa el boton para iniciar.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {jobs.map((job) => (
              <div key={job.id} className="px-5 py-3.5 flex items-center justify-between table-row-hover">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${
                    job.status === 'COMPLETED' ? 'bg-green-400' :
                    job.status === 'RUNNING' ? 'bg-cyan-400 animate-pulse' :
                    job.status === 'PENDING' ? 'bg-yellow-400' :
                    job.status === 'FAILED' ? 'bg-red-400' : 'bg-zinc-600'
                  }`} />
                  <div>
                    <p className={`text-sm font-medium ${statusColor(job.status)}`}>
                      {job.status}
                    </p>
                    <p className="text-xs text-zinc-600">
                      {new Date(job.createdAt).toLocaleString('es-UY')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-zinc-500">
                  <span>{job.totalFiles} archivos</span>
                  {job.successCount > 0 && (
                    <span className="flex items-center gap-1 text-green-400">
                      <CheckCircle2 className="w-3 h-3" /> {job.successCount}
                    </span>
                  )}
                  {job.failedCount > 0 && (
                    <span className="flex items-center gap-1 text-red-400">
                      <AlertCircle className="w-3 h-3" /> {job.failedCount}
                    </span>
                  )}
                  {job.durationMs && (
                    <span>{(job.durationMs / 1000).toFixed(1)}s</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
