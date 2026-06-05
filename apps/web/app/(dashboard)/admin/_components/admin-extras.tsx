'use client';

/**
 * Admin dashboard v3 extras — store filter, range selector, trend KPI cards,
 * and the new analytical panels (geography, payment mix, order-value
 * distribution, worker job types, cross-store comparison).
 *
 * These are additive: the original panels in page.tsx are untouched. Everything
 * here renders from the (now scoped + range-windowed) AdminMetrics payload.
 */

import { useState } from 'react';
import {
  Store,
  ChevronsUpDown,
  Layers,
  MapPin,
  CreditCard,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Briefcase,
  DollarSign,
  Tags,
  Building2,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Cell as PieCell,
} from 'recharts';
import type {
  AdminGeoBucket,
  AdminPaymentTypeBucket,
  AdminPaymentStatusBucket,
  AdminJobTypeBucket,
  AdminValueStats,
  AdminLabelsByTenantRow,
  AdminRevenueByTenantRow,
} from '@/app/api/admin/metrics/route';
import type { AdminTenantOption } from '@/app/api/admin/tenants/route';

const C = {
  cyan: '#06b6d4',
  emerald: '#10b981',
  violet: '#a855f7',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#3b82f6',
  zinc: '#3f3f46',
};
const SERIES = [C.cyan, C.emerald, C.violet, C.amber, C.blue, C.red, C.zinc];

// ─── Friendly labels ─────────────────────────────────────────────────────

const PAYMENT_TYPE_META: Record<string, { label: string; sub: string; color: string }> = {
  REMITENTE: { label: 'Paga la tienda', sub: 'envío bonificado', color: C.cyan },
  DESTINATARIO: { label: 'Paga el cliente', sub: 'contra-entrega', color: C.amber },
};

const PAYMENT_STATUS_META: Record<string, { label: string; color: string }> = {
  not_required: { label: 'No requiere', color: C.zinc },
  paid: { label: 'Cobrado', color: C.emerald },
  pending_manual: { label: 'Manual pendiente', color: C.amber },
  failed_rejected: { label: 'Rechazado', color: C.red },
};

const JOB_TYPE_META: Record<string, { label: string; color: string }> = {
  PROCESS_ORDERS: { label: 'Procesar pedidos', color: C.cyan },
  PROCESS_ORDERS_BULK: { label: 'Procesar (bulk)', color: C.blue },
  RETRY_FAILED: { label: 'Reintentos', color: C.amber },
  TEST_DAC: { label: 'Prueba DAC', color: C.violet },
};

// ─── small shared bits ───────────────────────────────────────────────────

function fmtUyu(n: number): string {
  const hasFraction = Math.abs(n - Math.round(n)) > 0.01;
  return `$${n.toLocaleString('es-UY', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString('es-UY');
}

function Panel({
  title,
  icon,
  right,
  children,
  className = '',
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-zinc-900/50 border border-white/[0.06] rounded-xl p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3 gap-2">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          {icon}
          {title}
        </h3>
        {right}
      </div>
      {children}
    </div>
  );
}

// ─── Sparkline (lightweight inline SVG) ──────────────────────────────────

export function Sparkline({
  data,
  color = C.cyan,
  width = 88,
  height = 28,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const y = (v: number) => height - ((v - min) / range) * (height - 4) - 2;
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const areaPts = `0,${height} ${pts} ${width},${height}`;
  const gid = `spark-${color.replace('#', '')}`;
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={areaPts} fill={`url(#${gid})`} stroke="none" />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={width} cy={y(data[data.length - 1])} r={1.9} fill={color} />
    </svg>
  );
}

// ─── Delta badge ─────────────────────────────────────────────────────────

export function DeltaBadge({
  deltaPct,
  goodWhenUp = true,
  neutral = false,
}: {
  deltaPct: number | null;
  goodWhenUp?: boolean;
  neutral?: boolean;
}) {
  if (deltaPct === null) {
    return <span className="text-[10px] text-zinc-600">sin base</span>;
  }
  const up = deltaPct > 0;
  const flat = deltaPct === 0;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  let color = 'text-zinc-500';
  if (!flat && !neutral) {
    const good = up === goodWhenUp;
    color = good ? 'text-emerald-400' : 'text-red-400';
  } else if (!flat && neutral) {
    color = 'text-zinc-400';
  }
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${color}`}>
      <Icon className="w-3 h-3" />
      {Math.abs(deltaPct).toFixed(1)}%
    </span>
  );
}

// ─── KPI trend card (value + delta vs previous window + sparkline) ───────

export function KpiTrendCard({
  icon,
  color,
  bg,
  label,
  value,
  sublabel,
  deltaPct,
  goodWhenUp = true,
  neutralDelta = false,
  spark,
  sparkColor = C.cyan,
}: {
  icon: React.ReactNode;
  color: string;
  bg: string;
  label: string;
  value: number | string;
  sublabel: string;
  deltaPct: number | null;
  goodWhenUp?: boolean;
  neutralDelta?: boolean;
  spark?: number[];
  sparkColor?: string;
}) {
  return (
    <div className={`bg-gradient-to-br ${bg} border border-white/[0.06] rounded-xl p-4`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] text-zinc-400 font-medium uppercase tracking-wider">
          {label}
        </span>
        <span className={color}>{icon}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-2xl font-bold text-white leading-none">{value}</p>
          <div className="flex items-center gap-1.5 mt-2">
            <DeltaBadge deltaPct={deltaPct} goodWhenUp={goodWhenUp} neutral={neutralDelta} />
            <span className="text-[11px] text-zinc-500 truncate">{sublabel}</span>
          </div>
        </div>
        {spark && spark.length > 1 && (
          <div className="flex-shrink-0 opacity-90">
            <Sparkline data={spark} color={sparkColor} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Store filter (dropdown) ─────────────────────────────────────────────

function FilterRow({
  label,
  sublabel,
  active,
  onClick,
  icon,
  dot,
}: {
  label: string;
  sublabel?: string;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${
        active ? 'bg-cyan-500/10 text-cyan-200' : 'text-zinc-300 hover:bg-white/[0.04]'
      }`}
    >
      {icon ? (
        <span className="flex-shrink-0 text-zinc-500">{icon}</span>
      ) : (
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            dot ? 'bg-emerald-400' : 'bg-zinc-600'
          }`}
        />
      )}
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium truncate">{label}</span>
        {sublabel && <span className="block text-[10px] text-zinc-500 truncate">{sublabel}</span>}
      </span>
      {active && <span className="text-cyan-400 text-[10px] flex-shrink-0">●</span>}
    </button>
  );
}

export function StoreFilter({
  tenants,
  value,
  onChange,
}: {
  tenants: AdminTenantOption[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? tenants.find((t) => t.id === value) ?? null : null;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-zinc-200 hover:bg-white/[0.06] transition-colors text-xs font-medium min-w-[190px]"
      >
        <Store className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
        <span className="truncate flex-1 text-left">
          {selected ? selected.name : 'Todas las tiendas'}
        </span>
        <ChevronsUpDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute z-50 mt-1 right-0 sm:left-0 sm:right-auto w-[280px] max-h-[380px] overflow-y-auto rounded-xl bg-zinc-950/95 backdrop-blur border border-white/[0.08] shadow-2xl p-1.5">
            <FilterRow
              label="Todas las tiendas"
              sublabel={`${tenants.length} cuentas`}
              active={!value}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              icon={<Layers className="w-3.5 h-3.5" />}
            />
            <div className="h-px bg-white/[0.06] my-1.5" />
            {tenants.map((t) => (
              <FilterRow
                key={t.id}
                label={t.name}
                sublabel={`${fmtInt(t.labelsThisMonth)} este mes${t.isActive ? '' : ' · inactiva'}`}
                active={value === t.id}
                dot={t.isActive}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Range selector (segmented 7 / 30 / 90) ──────────────────────────────

export function RangeSelector({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const opts = [7, 30, 90];
  return (
    <div className="inline-flex items-center rounded-lg bg-white/[0.03] border border-white/[0.08] p-0.5">
      {opts.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            value === o ? 'bg-cyan-500/15 text-cyan-300' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {o}d
        </button>
      ))}
    </div>
  );
}

// ─── Ranked horizontal bars (reused for geography + per-store) ───────────

function RankBars({
  items,
  color = C.cyan,
  max,
  formatValue = fmtInt,
  emptyMsg = 'Sin datos en el rango.',
}: {
  items: Array<{ key: string; label: string; value: number; sub?: string }>;
  color?: string;
  max?: number;
  formatValue?: (n: number) => string;
  emptyMsg?: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-zinc-500">{emptyMsg}</p>;
  }
  const peak = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2">
      {items.map((it) => {
        const pct = peak > 0 ? (it.value / peak) * 100 : 0;
        return (
          <div key={it.key}>
            <div className="flex items-center justify-between text-[11px] mb-1 gap-2">
              <span className="text-zinc-300 truncate" title={it.label}>
                {it.label}
              </span>
              <span className="text-zinc-400 font-medium flex-shrink-0">
                {formatValue(it.value)}
                {it.sub && <span className="text-zinc-600 font-normal"> · {it.sub}</span>}
              </span>
            </div>
            <div className="h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Geography panel (department bars + top cities) ──────────────────────

export function GeographyPanel({
  departments,
  cities,
}: {
  departments: AdminGeoBucket[];
  cities: AdminGeoBucket[];
}) {
  const topDepts = departments.slice(0, 8);
  const totalDept = departments.reduce((s, d) => s + d.count, 0);
  return (
    <Panel
      title="Geografía de envíos"
      icon={<MapPin className="w-3.5 h-3.5 text-cyan-400" />}
      right={<span className="text-[10px] text-zinc-600">por departamento · rango</span>}
    >
      {departments.length === 0 ? (
        <p className="text-xs text-zinc-500">Sin envíos en el rango.</p>
      ) : (
        <>
          <RankBars
            items={topDepts.map((d) => ({
              key: d.name,
              label: d.name,
              value: d.count,
              sub: totalDept > 0 ? `${((d.count / totalDept) * 100).toFixed(0)}%` : undefined,
            }))}
            color={C.cyan}
          />
          {cities.length > 0 && (
            <div className="mt-4 pt-3 border-t border-white/[0.06]">
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">
                Top ciudades
              </p>
              <div className="flex flex-wrap gap-1.5">
                {cities.slice(0, 10).map((c) => (
                  <span
                    key={c.name}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.03] border border-white/[0.06] text-[11px] text-zinc-300"
                  >
                    {c.name}
                    <span className="text-zinc-500">{fmtInt(c.count)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

// ─── Payment mix panel (who pays shipping + auto-pay health) ─────────────

function DonutTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload?: { sub?: string } }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="bg-zinc-900 border border-white/[0.1] rounded-lg p-2.5 shadow-2xl">
      <p className="text-xs text-white font-medium">{p.name}</p>
      <p className="text-[11px] text-zinc-400">
        {fmtInt(p.value ?? 0)} envíos
        {p.payload?.sub ? ` · ${p.payload.sub}` : ''}
      </p>
    </div>
  );
}

export function PaymentMixPanel({
  paymentTypes,
  paymentStatuses,
}: {
  paymentTypes: AdminPaymentTypeBucket[];
  paymentStatuses: AdminPaymentStatusBucket[];
}) {
  const pieData = paymentTypes.map((p) => {
    const meta = PAYMENT_TYPE_META[p.type] ?? { label: p.type, sub: '', color: C.zinc };
    return { name: meta.label, value: p.count, sub: meta.sub, color: meta.color };
  });
  const totalTypes = paymentTypes.reduce((s, p) => s + p.count, 0);
  // Auto-pay health is only meaningful beyond the dominant "not_required".
  const autoPay = paymentStatuses.filter((s) => s.status !== 'not_required');
  return (
    <Panel
      title="Quién paga el envío"
      icon={<CreditCard className="w-3.5 h-3.5 text-cyan-400" />}
      right={<span className="text-[10px] text-zinc-600">REMITENTE vs DESTINATARIO · rango</span>}
    >
      {totalTypes === 0 ? (
        <p className="text-xs text-zinc-500">Sin envíos en el rango.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={42}
                  outerRadius={70}
                  paddingAngle={2}
                  stroke="#0a0a0a"
                  strokeWidth={2}
                >
                  {pieData.map((d, i) => (
                    <PieCell key={i} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip content={<DonutTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-2">
            {pieData.map((d) => (
              <div key={d.name} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-zinc-200 font-medium truncate">{d.name}</p>
                  <p className="text-[10px] text-zinc-500">{d.sub}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-white">{fmtInt(d.value)}</p>
                  <p className="text-[10px] text-zinc-500">
                    {totalTypes > 0 ? `${((d.value / totalTypes) * 100).toFixed(0)}%` : '0%'}
                  </p>
                </div>
              </div>
            ))}
            {autoPay.length > 0 && (
              <div className="mt-2 pt-2 border-t border-white/[0.06]">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">
                  Cobro automático
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {autoPay.map((s) => {
                    const meta = PAYMENT_STATUS_META[s.status] ?? { label: s.status, color: C.zinc };
                    return (
                      <span
                        key={s.status}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border"
                        style={{
                          color: meta.color,
                          borderColor: `${meta.color}33`,
                          background: `${meta.color}14`,
                        }}
                      >
                        {meta.label}
                        <span className="font-semibold">{fmtInt(s.count)}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ─── Order-value distribution (histogram + stats) ────────────────────────

function HistogramTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-white/[0.1] rounded-lg p-2.5 shadow-2xl">
      <p className="text-[10px] text-zinc-500 mb-0.5">{label}</p>
      <p className="text-xs text-white font-medium">{fmtInt(payload[0].value ?? 0)} pedidos</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-lg px-2.5 py-2">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className="text-sm font-bold text-white mt-0.5">{value}</p>
    </div>
  );
}

export function ValueDistributionPanel({ stats }: { stats: AdminValueStats }) {
  return (
    <Panel
      title="Valor de los pedidos"
      icon={<Tags className="w-3.5 h-3.5 text-emerald-400" />}
      right={<span className="text-[10px] text-zinc-600">total Shopify (UYU) · rango</span>}
    >
      {stats.count === 0 ? (
        <p className="text-xs text-zinc-500">Sin pedidos con valor en el rango.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <Stat label="Promedio" value={fmtUyu(stats.avgUyu)} />
            <Stat label="Mediana" value={fmtUyu(stats.medianUyu)} />
            <Stat label="Mínimo" value={fmtUyu(stats.minUyu)} />
            <Stat label="Máximo" value={fmtUyu(stats.maxUyu)} />
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.buckets} margin={{ top: 6, right: 6, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#71717a', fontSize: 9 }}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                  interval={0}
                />
                <YAxis
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<HistogramTooltip />} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {stats.buckets.map((_, i) => (
                    <Cell key={i} fill={SERIES[i % SERIES.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Panel>
  );
}

// ─── Worker job types ────────────────────────────────────────────────────

export function JobTypePanel({ jobTypes }: { jobTypes: AdminJobTypeBucket[] }) {
  return (
    <Panel
      title="Jobs por tipo"
      icon={<Briefcase className="w-3.5 h-3.5 text-cyan-400" />}
      right={<span className="text-[10px] text-zinc-600">rango</span>}
    >
      {jobTypes.length === 0 ? (
        <p className="text-xs text-zinc-500">Ningún job en el rango.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {jobTypes.map((j) => {
            const meta = JOB_TYPE_META[j.type] ?? { label: j.type, color: C.zinc };
            return (
              <div
                key={j.type}
                className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-zinc-400 truncate">{meta.label}</span>
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: meta.color }}
                  />
                </div>
                <p className="text-xl font-bold text-white">{fmtInt(j.count)}</p>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ─── Cross-store comparison (labels + revenue by store) ──────────────────

export function StoreComparison({
  labelsByTenant,
  revenueByTenant,
  onPick,
}: {
  labelsByTenant: AdminLabelsByTenantRow[];
  revenueByTenant: AdminRevenueByTenantRow[];
  onPick?: (tenantId: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Panel
        title="Etiquetas por tienda"
        icon={<Building2 className="w-3.5 h-3.5 text-cyan-400" />}
        right={<span className="text-[10px] text-zinc-600">rango · top 12</span>}
      >
        {labelsByTenant.length === 0 ? (
          <p className="text-xs text-zinc-500">Sin etiquetas en el rango.</p>
        ) : (
          <RankBars
            items={labelsByTenant.map((t) => ({ key: t.tenantId, label: t.tenantName, value: t.count }))}
            color={C.cyan}
          />
        )}
        {onPick && labelsByTenant.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {labelsByTenant.slice(0, 6).map((t) => (
              <button
                key={t.tenantId}
                onClick={() => onPick(t.tenantId)}
                className="text-[10px] px-2 py-0.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-zinc-400 hover:text-cyan-300 hover:border-cyan-500/30 transition-colors"
              >
                ver {t.tenantName}
              </button>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Ingresos por tienda"
        icon={<DollarSign className="w-3.5 h-3.5 text-emerald-400" />}
        right={<span className="text-[10px] text-zinc-600">packs PAID · rango</span>}
      >
        {revenueByTenant.length === 0 ? (
          <p className="text-xs text-zinc-500">Sin compras en el rango.</p>
        ) : (
          <RankBars
            items={revenueByTenant.map((t) => ({
              key: t.tenantId,
              label: t.tenantName,
              value: t.uyu,
              sub: `${t.count} compra${t.count === 1 ? '' : 's'}`,
            }))}
            color={C.emerald}
            formatValue={fmtUyu}
          />
        )}
      </Panel>
    </div>
  );
}
