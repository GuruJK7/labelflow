'use client';

import { useEffect, useState } from 'react';
import {
  Image,
  Video,
  Play,
  Pause,
  AlertCircle,
  Clock,
  Loader2,
  ExternalLink,
} from 'lucide-react';

interface ManagedAd {
  id: string;
  creativeName: string;
  creativeType: string;
  status: string;
  metaAdId: string | null;
  headline: string | null;
  bodyText: string | null;
  callToAction: string | null;
  linkUrl: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  ctr: number;
  errorMessage: string | null;
  createdAt: string;
}

export default function CreativosPage() {
  const [ads, setAds] = useState<ManagedAd[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchAds = async () => {
    try {
      const res = await fetch('/api/ads/managed');
      if (res.ok) {
        const data = await res.json();
        setAds(data.data?.ads || []);
      }
    } catch {
      // Silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAds();
  }, []);

  const toggleAd = async (adId: string, currentStatus: string) => {
    const action = currentStatus === 'ACTIVE' ? 'pause' : 'activate';
    setToggling(adId);
    try {
      const res = await fetch(`/api/ads/managed/${adId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        await fetchAds();
      }
    } catch {
      // Silent
    } finally {
      setToggling(null);
    }
  };

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      ACTIVE: 'bg-green-500/10 text-green-400 border-green-500/20',
      PAUSED: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
      PAUSED_AUTO: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
      PENDING: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
      ERROR: 'bg-red-500/10 text-red-400 border-red-500/20',
      DELETED: 'bg-zinc-800/50 text-zinc-600 border-zinc-700/20',
    };
    const labels: Record<string, string> = {
      ACTIVE: 'Activo',
      PAUSED: 'Pausado',
      PAUSED_AUTO: 'Auto-pausado',
      PENDING: 'Pendiente',
      ERROR: 'Error',
      DELETED: 'Eliminado',
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border ${styles[status] || styles.PENDING}`}>
        {labels[status] || status}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Anuncios Gestionados</h2>
          <span className="text-xs text-zinc-500">{ads.length} total</span>
        </div>

        {ads.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <Image className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
            <p className="text-sm text-zinc-500">No hay anuncios aun.</p>
            <p className="text-xs text-zinc-600 mt-1">Escanea tu carpeta de Drive para crear anuncios.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[11px] text-zinc-500 uppercase tracking-wider border-b border-white/[0.04]">
                  <th className="px-5 py-3 font-medium">Creativo</th>
                  <th className="px-5 py-3 font-medium">Estado</th>
                  <th className="px-5 py-3 font-medium">Impresiones</th>
                  <th className="px-5 py-3 font-medium">Clicks</th>
                  <th className="px-5 py-3 font-medium">CTR</th>
                  <th className="px-5 py-3 font-medium">Gasto</th>
                  <th className="px-5 py-3 font-medium">Fecha</th>
                  <th className="px-5 py-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {ads.map((ad) => (
                  <tr key={ad.id} className="table-row-hover">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        {ad.creativeType === 'VIDEO' ? (
                          <Video className="w-4 h-4 text-purple-400 flex-shrink-0" />
                        ) : (
                          <Image className="w-4 h-4 text-cyan-400 flex-shrink-0" />
                        )}
                        <div>
                          <p className="text-sm font-medium text-white truncate max-w-[200px]">
                            {ad.creativeName}
                          </p>
                          {ad.headline && (
                            <p className="text-[11px] text-zinc-600 truncate max-w-[200px]">{ad.headline}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">{statusBadge(ad.status)}</td>
                    <td className="px-5 py-3.5 text-sm text-zinc-400 font-mono">{ad.impressions.toLocaleString()}</td>
                    <td className="px-5 py-3.5 text-sm text-zinc-400 font-mono">{ad.clicks.toLocaleString()}</td>
                    <td className="px-5 py-3.5 text-sm text-zinc-400 font-mono">{ad.ctr.toFixed(2)}%</td>
                    <td className="px-5 py-3.5 text-sm text-zinc-400 font-mono">${ad.spend.toFixed(2)}</td>
                    <td className="px-5 py-3.5 text-xs text-zinc-600">{new Date(ad.createdAt).toLocaleDateString('es-UY')}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        {(ad.status === 'ACTIVE' || ad.status === 'PAUSED' || ad.status === 'PAUSED_AUTO') && (
                          <button
                            onClick={() => toggleAd(ad.id, ad.status)}
                            disabled={toggling === ad.id}
                            className="p-1.5 rounded-md hover:bg-white/[0.04] text-zinc-500 hover:text-white transition-colors disabled:opacity-50"
                            title={ad.status === 'ACTIVE' ? 'Pausar' : 'Activar'}
                          >
                            {toggling === ad.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : ad.status === 'ACTIVE' ? (
                              <Pause className="w-3.5 h-3.5" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                        {ad.metaAdId && (
                          <a
                            href={`https://www.facebook.com/adsmanager/manage/ads?act=&selected_ad_ids=${ad.metaAdId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 rounded-md hover:bg-white/[0.04] text-zinc-500 hover:text-white transition-colors"
                            title="Ver en Meta"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {ad.errorMessage && (
                          <span title={ad.errorMessage}>
                            <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
