'use client';

import { useEffect, useState } from 'react';
import {
  Users,
  Tags,
  Brain,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  Loader2,
  Activity,
  CreditCard,
  ShoppingBag,
  Truck,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Area,
  AreaChart,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import type { AdminMetrics, AdminTenantRow } from '@/app/api/admin/metrics/route';

const PLAN_NAMES: Record<string, string> = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
  inactive: 'Sin plan',
};

const PIE_COLORS = ['#06b6d4', '#10b981', '#a855f7', '#f59e0b', '#ef4444', '#3f3f46'];

export default function AdminDashboardPage() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load(showRefreshSpinner = false) {
    if (showRefreshSpinner) setRefreshing(true);
    try {
      const res = await fetch('/api/admin/metrics', { cache: 'no-store' });
      if (!res.ok) {
        setError(res.status === 404 ? 'No autorizado' : `Error ${res.status}`);
        return;
      }
      const json = await res.json();
      setMetrics(json.data as AdminMetrics);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => load(false), 60_000); // 1 min auto-refresh
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Cargando métricas…
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="text-red-400 text-sm py-8">
        {error ?? 'No se pudieron cargar las métricas'}
      </div>
    );
  }

  const { totals, daily, planDistribution, topTenants, problemTenants, anthropicCost } = metrics;
  // Prefer real Anthropic spend if the admin key is configured. Falls back
  // to the local AddressResolution cost (which only covers one feature).
  const aiMonthUsd = anthropicCost.configured && anthropicCost.fetchedOk
    ? anthropicCost.totals.totalUsd
    : totals.aiCostUsdThisMonth;
  const aiMonthSublabel = anthropicCost.configured && anthropicCost.fetchedOk
    ? `Anthropic · últimos ${metrics.rangeDays}d`
    : `${totals.aiCallsThisMonth.toLocaleString('es-UY')} calls (Address Resolver)`;

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-4 h-4 text-cyan-400" />
            <span className="text-[11px] font-medium text-cyan-400 uppercase tracking-wider">
              Admin · Visión global
            </span>
          </div>
          <h1 className="text-2xl font-bold text-white">Panel de operador</h1>
          <p className="text-zinc-500 text-sm mt-1">
            Métricas agregadas de todas las cuentas. Solo visible para vos.
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-zinc-300 hover:bg-white/[0.06] transition-colors text-xs font-medium disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refrescar
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard
          icon={<Users className="w-4 h-4" />}
          color="text-cyan-400"
          bg="from-cyan-500/20 to-cyan-500/5"
          label="Cuentas"
          value={totals.tenants}
          sublabel={`${totals.activeTenants} activas · ${totals.paidTenants} pagas`}
        />
        <KpiCard
          icon={<Tags className="w-4 h-4" />}
          color="text-emerald-400"
          bg="from-emerald-500/20 to-emerald-500/5"
          label="Etiquetas hoy"
          value={totals.labelsToday}
          sublabel={`${totals.labelsThisMonth.toLocaleString('es-UY')} este mes`}
        />
        <KpiCard
          icon={<Brain className="w-4 h-4" />}
          color="text-violet-400"
          bg="from-violet-500/20 to-violet-500/5"
          label="Costo IA"
          value={`$${aiMonthUsd.toFixed(2)}`}
          sublabel={aiMonthSublabel}
        />
        <KpiCard
          icon={<TrendingUp className="w-4 h-4" />}
          color="text-amber-400"
          bg="from-amber-500/20 to-amber-500/5"
          label="Tasa de éxito"
          value={`${totals.successRate}%`}
          sublabel={`${totals.failedThisMonth} fallidas este mes`}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
        {/* Labels per day — area chart */}
        <div className="lg:col-span-2 bg-zinc-900/50 border border-white/[0.06] rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-white">Etiquetas por día (últimos {metrics.rangeDays}d)</h3>
            <span className="text-[11px] text-zinc-600">cyan = ok · rojo = fallidas</span>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily} margin={{ top: 10, right: 8, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="okGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="failGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  tickFormatter={shortDate}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<DarkTooltip formatter={(v: number) => v.toLocaleString('es-UY')} />} />
                <Area type="monotone" dataKey="labels" stroke="#06b6d4" strokeWidth={2} fill="url(#okGrad)" />
                <Area type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} fill="url(#failGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Plan distribution — pie */}
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-2">Distribución por plan</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={planDistribution.map((p) => ({ name: PLAN_NAMES[p.plan] ?? p.plan, value: p.count }))}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={85}
                  paddingAngle={2}
                  stroke="#0a0a0a"
                  strokeWidth={2}
                >
                  {planDistribution.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<DarkTooltip />} />
                <Legend
                  verticalAlign="bottom"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* AI cost daily — uses Anthropic Admin API when configured */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-4 mb-8">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Brain className="w-3.5 h-3.5 text-violet-400" /> Costo de IA por día
            </h3>
            {anthropicCost.configured && anthropicCost.fetchedOk ? (
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Anthropic Admin API · Token · Web search · Code exec · Session
              </p>
            ) : anthropicCost.configured && !anthropicCost.fetchedOk ? (
              <p className="text-[11px] text-amber-400 mt-0.5">
                Error al traer Admin API: {anthropicCost.errorMessage}. Mostrando solo Address Resolver.
              </p>
            ) : (
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Address Resolver únicamente. Configurá <code className="text-zinc-400">ANTHROPIC_ADMIN_API_KEY</code> para ver el spend completo.
              </p>
            )}
          </div>
          {anthropicCost.configured && anthropicCost.fetchedOk && (
            <div className="text-right">
              <p className="text-lg font-bold text-white">${anthropicCost.totals.totalUsd.toFixed(2)}</p>
              <p className="text-[10px] text-zinc-600">total {metrics.rangeDays}d</p>
            </div>
          )}
        </div>

        {/* Desglose por tipo (solo si Anthropic API funcionó) */}
        {anthropicCost.configured && anthropicCost.fetchedOk && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            <CostBreakdownChip color="#a855f7" label="Tokens" usd={anthropicCost.totals.tokensUsd} />
            <CostBreakdownChip color="#06b6d4" label="Web search" usd={anthropicCost.totals.webSearchUsd} />
            <CostBreakdownChip color="#10b981" label="Code exec" usd={anthropicCost.totals.codeExecUsd} />
            <CostBreakdownChip color="#f59e0b" label="Session" usd={anthropicCost.totals.sessionUsd} />
          </div>
        )}

        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            {anthropicCost.configured && anthropicCost.fetchedOk ? (
              <AreaChart data={anthropicCost.daily} margin={{ top: 10, right: 8, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="tokensGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a855f7" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#a855f7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  tickFormatter={shortDate}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <Tooltip
                  content={
                    <DarkTooltip
                      formatter={(v: number) => `$${v.toFixed(4)}`}
                    />
                  }
                />
                <Area type="monotone" dataKey="tokensUsd" name="Tokens" stackId="1" stroke="#a855f7" fill="url(#tokensGrad)" strokeWidth={1.5} />
                <Area type="monotone" dataKey="webSearchUsd" name="Web search" stackId="1" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.25} strokeWidth={1.5} />
                <Area type="monotone" dataKey="codeExecUsd" name="Code exec" stackId="1" stroke="#10b981" fill="#10b981" fillOpacity={0.25} strokeWidth={1.5} />
                <Area type="monotone" dataKey="sessionUsd" name="Session" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25} strokeWidth={1.5} />
              </AreaChart>
            ) : (
              <LineChart data={daily} margin={{ top: 10, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  tickFormatter={shortDate}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <Tooltip
                  content={<DarkTooltip formatter={(v: number, key) => (key === 'aiCostUsd' ? `$${v.toFixed(4)}` : v)} />}
                />
                <Line type="monotone" dataKey="aiCostUsd" name="Address Resolver" stroke="#a855f7" strokeWidth={2} dot={false} />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top tenants */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl mb-8 overflow-hidden">
        <div className="flex items-center gap-2 p-4 border-b border-white/[0.06]">
          <ShoppingBag className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-white">Top cuentas (etiquetas este mes)</h3>
        </div>
        <TenantTable rows={topTenants} emptyMsg="Sin etiquetas este mes" />
      </div>

      {/* Problem tenants */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl mb-8 overflow-hidden">
        <div className="flex items-center gap-2 p-4 border-b border-white/[0.06]">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-white">Cuentas con problemas</h3>
          <span className="text-[10px] text-zinc-600 ml-auto">
            (errores en últimos 30d, o uso sin suscripción activa)
          </span>
        </div>
        <TenantTable
          rows={problemTenants}
          emptyMsg="Ninguna cuenta con problemas — todo en orden."
          highlightFailed
        />
      </div>

      <p className="text-[10px] text-zinc-600 text-center">
        Generado {new Date(metrics.generatedAt).toLocaleString('es-UY')} · auto-refresh cada 60s
      </p>
    </div>
  );
}

// ─── KPI card ──────────────────────────────────────────────────────────

function KpiCard({
  icon,
  color,
  bg,
  label,
  value,
  sublabel,
}: {
  icon: React.ReactNode;
  color: string;
  bg: string;
  label: string;
  value: number | string;
  sublabel: string;
}) {
  return (
    <div className={`bg-gradient-to-br ${bg} border border-white/[0.06] rounded-xl p-4`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] text-zinc-400 font-medium uppercase tracking-wider">{label}</span>
        <span className={color}>{icon}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-[11px] text-zinc-500 mt-1 truncate">{sublabel}</p>
    </div>
  );
}

// ─── Tenant table ──────────────────────────────────────────────────────

function TenantTable({
  rows,
  emptyMsg,
  highlightFailed = false,
}: {
  rows: AdminTenantRow[];
  emptyMsg: string;
  highlightFailed?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-zinc-500 p-6 text-center">{emptyMsg}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-white/[0.02]">
          <tr className="text-left text-[10px] uppercase text-zinc-500 tracking-wider">
            <th className="px-4 py-2.5 font-medium">Cuenta</th>
            <th className="px-4 py-2.5 font-medium">Plan</th>
            <th className="px-4 py-2.5 font-medium text-right">Mes</th>
            <th className="px-4 py-2.5 font-medium text-right">7d</th>
            <th className="px-4 py-2.5 font-medium text-right">30d</th>
            {highlightFailed && (
              <th className="px-4 py-2.5 font-medium text-right">Falladas 30d</th>
            )}
            <th className="px-4 py-2.5 font-medium text-right">IA $30d</th>
            <th className="px-4 py-2.5 font-medium">Conexión</th>
            <th className="px-4 py-2.5 font-medium">Último run</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tenantId} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
              <td className="px-4 py-2.5">
                <div className="font-medium text-white">{r.tenantName || r.tenantSlug}</div>
                <div className="text-[10px] text-zinc-500 truncate max-w-[220px]">{r.email}</div>
              </td>
              <td className="px-4 py-2.5"><PlanBadge row={r} /></td>
              <td className="px-4 py-2.5 text-right text-zinc-300">{r.labelsThisMonth.toLocaleString('es-UY')}</td>
              <td className="px-4 py-2.5 text-right text-zinc-400">{r.labelsLast7Days.toLocaleString('es-UY')}</td>
              <td className="px-4 py-2.5 text-right text-zinc-400">{r.labelsLast30Days.toLocaleString('es-UY')}</td>
              {highlightFailed && (
                <td className="px-4 py-2.5 text-right">
                  <span className={r.failedLast30Days > 0 ? 'text-red-400' : 'text-zinc-600'}>
                    {r.failedLast30Days}
                  </span>
                </td>
              )}
              <td className="px-4 py-2.5 text-right text-zinc-400">${r.aiCostUsdLast30Days.toFixed(2)}</td>
              <td className="px-4 py-2.5">
                <ConnectionDot label="Shopify" connected={r.shopifyConnected} icon={<ShoppingBag className="w-2.5 h-2.5" />} />
                <ConnectionDot label="DAC" connected={r.dacConnected} icon={<Truck className="w-2.5 h-2.5" />} />
              </td>
              <td className="px-4 py-2.5 text-zinc-500">
                {r.lastRunAt ? timeAgo(r.lastRunAt) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanBadge({ row }: { row: AdminTenantRow }) {
  const planLabel = row.plan ? PLAN_NAMES[row.plan] ?? row.plan : 'Sin plan';
  const status = row.subscriptionStatus;
  const tone =
    status === 'ACTIVE'
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      : status === 'TRIALING'
        ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
        : status === 'PAST_DUE'
          ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
          : status === 'CANCELED'
            ? 'bg-red-500/10 text-red-400 border-red-500/20'
            : 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20';
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${tone}`}
      title={status}
    >
      <CreditCard className="w-2.5 h-2.5" />
      {planLabel}
    </span>
  );
}

function CostBreakdownChip({
  color,
  label,
  usd,
}: {
  color: string;
  label: string;
  usd: number;
}) {
  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/[0.04] rounded-lg px-2.5 py-1.5">
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wider truncate">{label}</p>
        <p className="text-xs font-medium text-white">${usd.toFixed(usd < 1 ? 4 : 2)}</p>
      </div>
    </div>
  );
}

function ConnectionDot({
  label,
  connected,
  icon,
}: {
  label: string;
  connected: boolean;
  icon: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 mr-1.5 text-[10px] ${
        connected ? 'text-emerald-400' : 'text-zinc-600'
      }`}
      title={`${label}: ${connected ? 'conectado' : 'no configurado'}`}
    >
      {icon} {label}
    </span>
  );
}

// ─── Tooltip ───────────────────────────────────────────────────────────

interface TooltipPayloadEntry {
  name?: string;
  value?: number;
  dataKey?: string;
  color?: string;
}

interface DarkTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  formatter?: (v: number, key?: string) => string | number;
}

function DarkTooltip({ active, payload, label, formatter }: DarkTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-white/[0.1] rounded-lg p-2.5 shadow-2xl">
      {label !== undefined && (
        <p className="text-[10px] text-zinc-500 mb-1">{shortDate(String(label))}</p>
      )}
      {payload.map((p, i) => {
        const key = p.dataKey ?? p.name ?? '';
        const raw = p.value ?? 0;
        const display = formatter ? formatter(raw, key) : raw;
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
            <span className="text-zinc-400">{p.name ?? key}:</span>
            <span className="text-white font-medium">{display}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

function shortDate(iso: string): string {
  // "2026-04-26" → "26 Abr"
  if (!iso || iso.length < 10) return iso;
  const m = iso.slice(5, 7);
  const d = iso.slice(8, 10);
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1] ?? m}`;
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
