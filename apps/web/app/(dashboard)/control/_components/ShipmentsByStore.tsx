'use client';

/**
 * Shipments-per-store filter + chart for the control dashboard.
 *
 * "Cuantos envios por tienda" over a date window (preset 7/30/90 days or a
 * custom from/to). Fetched on demand from GET /api/v1/control/shipments — NOT
 * on the page's fast poll loop. recharts horizontal bars, dark + cyan theme.
 */

import { useCallback, useEffect, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { BarChart3, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Row {
  tenantId: string;
  tenantName: string;
  count: number;
}
interface ShipmentsData {
  stores: Row[];
  total: number;
  window: string;
}

const PRESETS = [7, 30, 90];
const BAR_COLORS = ['#22d3ee', '#34d399', '#2dd4bf', '#38bdf8', '#a3e635', '#facc15', '#818cf8'];

export function ShipmentsByStore() {
  const [range, setRange] = useState(30);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [custom, setCustom] = useState(false);
  const [data, setData] = useState<ShipmentsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (qs: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/v1/control/shipments?${qs}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No se pudo cargar');
        return;
      }
      setData(json.data as ShipmentsData);
    } catch {
      setError('Error de conexion');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial + whenever a preset is chosen.
  useEffect(() => {
    if (!custom) load(`range=${range}`);
  }, [range, custom, load]);

  const applyCustom = () => {
    if (!from || !to) return;
    setCustom(true);
    load(`from=${from}&to=${to}`);
  };

  const maxCount = Math.max(1, ...(data?.stores.map((s) => s.count) ?? [1]));
  const chartHeight = Math.max(120, (data?.stores.length ?? 1) * 46 + 20);

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Envios por tienda</h2>
          {data && <span className="text-xs text-zinc-500">{data.window} · {data.total} total</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-white/[0.07]">
            {PRESETS.map((d) => (
              <button
                key={d}
                onClick={() => {
                  setCustom(false);
                  setRange(d);
                }}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  !custom && range === d ? 'bg-cyan-500 text-zinc-950' : 'bg-white/[0.02] text-zinc-400 hover:text-white',
                )}
              >
                {d}d
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-xs text-zinc-300 [color-scheme:dark]"
            />
            <span className="text-zinc-600 text-xs">a</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-1.5 text-xs text-zinc-300 [color-scheme:dark]"
            />
            <button
              onClick={applyCustom}
              disabled={!from || !to}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                custom ? 'bg-cyan-500 text-zinc-950' : 'bg-white/[0.03] border border-white/[0.07] text-zinc-300 hover:text-white disabled:opacity-40',
              )}
            >
              Aplicar
            </button>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {loading && !data ? (
        <div className="flex items-center justify-center py-12 text-zinc-500">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : data && data.stores.length > 0 && data.total > 0 ? (
        <div style={{ width: '100%', height: chartHeight }} className={cn(loading && 'opacity-60')}>
          <ResponsiveContainer>
            <BarChart data={data.stores} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }} barCategoryGap="28%">
              <XAxis type="number" domain={[0, maxCount]} hide />
              <YAxis
                type="category"
                dataKey="tenantName"
                width={120}
                tick={{ fill: '#a1a1aa', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                contentStyle={{
                  background: '#0a0a0c',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 12,
                  fontSize: 12,
                  color: '#fff',
                }}
                formatter={(v) => [`${v} envios`, '']}
                labelStyle={{ color: '#a1a1aa' }}
              />
              <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={26}>
                {data.stores.map((s, i) => (
                  <Cell key={s.tenantId} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="py-10 text-center text-sm text-zinc-500">Sin envios en este periodo.</div>
      )}
    </div>
  );
}
