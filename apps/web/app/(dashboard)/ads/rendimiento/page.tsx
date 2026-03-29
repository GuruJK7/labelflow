'use client';

import { useEffect, useState } from 'react';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Loader2,
  MousePointerClick,
  Eye,
  DollarSign,
  ShoppingCart,
} from 'lucide-react';

interface ManagedAd {
  id: string;
  creativeName: string;
  status: string;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  purchaseIntentRate: number;
  lastCheckedAt: string | null;
}

export default function RendimientoPage() {
  const [ads, setAds] = useState<ManagedAd[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
    fetchAds();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  // Aggregate stats
  const totalImpressions = ads.reduce((sum, a) => sum + a.impressions, 0);
  const totalClicks = ads.reduce((sum, a) => sum + a.clicks, 0);
  const totalSpend = ads.reduce((sum, a) => sum + a.spend, 0);
  const totalPurchases = ads.reduce((sum, a) => sum + a.purchases, 0);
  const avgCtr = ads.length > 0 ? ads.reduce((sum, a) => sum + a.ctr, 0) / ads.length : 0;
  const avgRoas = ads.length > 0 ? ads.reduce((sum, a) => sum + a.roas, 0) / ads.length : 0;

  return (
    <div className="space-y-6">
      {/* Aggregate metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { label: 'Impresiones', value: totalImpressions.toLocaleString(), icon: Eye, color: 'text-cyan-400' },
          { label: 'Clicks', value: totalClicks.toLocaleString(), icon: MousePointerClick, color: 'text-blue-400' },
          { label: 'Gasto Total', value: `$${totalSpend.toFixed(2)}`, icon: DollarSign, color: 'text-yellow-400' },
          { label: 'Compras', value: totalPurchases.toString(), icon: ShoppingCart, color: 'text-green-400' },
          { label: 'CTR Promedio', value: `${avgCtr.toFixed(2)}%`, icon: TrendingUp, color: 'text-purple-400' },
          { label: 'ROAS Promedio', value: avgRoas.toFixed(2), icon: BarChart3, color: 'text-orange-400' },
        ].map((metric) => (
          <div key={metric.label} className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <metric.icon className={`w-4 h-4 ${metric.color}`} />
              <span className="text-[11px] text-zinc-500 uppercase tracking-wider">{metric.label}</span>
            </div>
            <p className="text-xl font-bold text-white font-mono">{metric.value}</p>
          </div>
        ))}
      </div>

      {/* Per-ad performance table */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white">Rendimiento por Anuncio</h2>
        </div>

        {ads.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <BarChart3 className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
            <p className="text-sm text-zinc-500">Sin datos de rendimiento aun.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[11px] text-zinc-500 uppercase tracking-wider border-b border-white/[0.04]">
                  <th className="px-5 py-3 font-medium">Anuncio</th>
                  <th className="px-5 py-3 font-medium">Estado</th>
                  <th className="px-5 py-3 font-medium">Impr.</th>
                  <th className="px-5 py-3 font-medium">Clicks</th>
                  <th className="px-5 py-3 font-medium">CTR</th>
                  <th className="px-5 py-3 font-medium">CPC</th>
                  <th className="px-5 py-3 font-medium">CPM</th>
                  <th className="px-5 py-3 font-medium">Gasto</th>
                  <th className="px-5 py-3 font-medium">Compras</th>
                  <th className="px-5 py-3 font-medium">ROAS</th>
                  <th className="px-5 py-3 font-medium">Intent Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {ads.map((ad) => (
                  <tr key={ad.id} className="table-row-hover">
                    <td className="px-5 py-3 text-sm font-medium text-white truncate max-w-[180px]">{ad.creativeName}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs font-medium ${
                        ad.status === 'ACTIVE' ? 'text-green-400' :
                        ad.status === 'PAUSED_AUTO' ? 'text-orange-400' :
                        ad.status === 'PAUSED' ? 'text-yellow-400' : 'text-zinc-500'
                      }`}>
                        {ad.status === 'ACTIVE' ? 'Activo' :
                         ad.status === 'PAUSED_AUTO' ? 'Auto-pausado' :
                         ad.status === 'PAUSED' ? 'Pausado' : ad.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-zinc-400 font-mono">{ad.impressions.toLocaleString()}</td>
                    <td className="px-5 py-3 text-sm text-zinc-400 font-mono">{ad.clicks.toLocaleString()}</td>
                    <td className="px-5 py-3 text-sm text-zinc-400 font-mono">{ad.ctr.toFixed(2)}%</td>
                    <td className="px-5 py-3 text-sm text-zinc-400 font-mono">${ad.cpc.toFixed(2)}</td>
                    <td className="px-5 py-3 text-sm text-zinc-400 font-mono">${ad.cpm.toFixed(2)}</td>
                    <td className="px-5 py-3 text-sm text-zinc-400 font-mono">${ad.spend.toFixed(2)}</td>
                    <td className="px-5 py-3 text-sm text-zinc-400 font-mono">{ad.purchases}</td>
                    <td className="px-5 py-3">
                      <span className={`text-sm font-mono font-medium ${ad.roas >= 2 ? 'text-green-400' : ad.roas >= 1 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {ad.roas.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-sm font-mono ${ad.purchaseIntentRate >= 5 ? 'text-green-400' : 'text-zinc-400'}`}>
                        {ad.purchaseIntentRate.toFixed(1)}%
                      </span>
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
