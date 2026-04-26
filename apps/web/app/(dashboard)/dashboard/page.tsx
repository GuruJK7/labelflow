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
  ArrowUpDown,
  Filter,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { JobFeedPanel } from '@/components/JobFeedPanel';
import { ShipmentInsights } from '@/components/ShipmentInsights';

interface ScheduleSlot {
  time: string;
  maxOrders: number;
}

interface StatsData {
  labelsToday: number;
  labelsMonth: number;
  successRate: number;
  lastRunAt: string | null;
  shopifyTokenSet: boolean;
  dacPasswordSet: boolean;
  emailPassSet: boolean;
  scheduleSlots: ScheduleSlot[] | null;
  cronSchedule: string | null;
  isActive: boolean;
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
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [orderSort, setOrderSort] = useState<'oldest_first' | 'newest_first'>('oldest_first');
  // `allowedProductTypes` is the persisted whitelist. Each entry can be a
  // product title, product_type, or vendor — the worker matches any of them.
  const [allowedProductTypes, setAllowedProductTypes] = useState<string[]>([]);
  // Individual products surfaced as chips in the dashboard filter. Sourced
  // from the `productTypeCache` (Tenant.productTypeCache) which is rebuilt
  // each time the user clicks "Escanear Shopify".
  const [availableProducts, setAvailableProducts] = useState<
    Array<{ id: string; title: string; type: string; vendor: string }>
  >([]);
  const [scanning, setScanning] = useState(false);
  const [savingSort, setSavingSort] = useState(false);
  const [fulfillMode, setFulfillMode] = useState<'off' | 'on' | 'always'>('on');
  const [savingFulfill, setSavingFulfill] = useState(false);
  // Shopify scope diagnostic: if critical write scopes are missing, the
  // worker's fulfillment POST will 403 / return no fulfillable orders,
  // which used to trigger the double-shipping loop. Surfacing this here
  // lets the operator see what needs re-authorizing in Shopify.
  const [missingShopifyScopes, setMissingShopifyScopes] = useState<string[] | null>(null);

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

      // Use real label counts from API (calculated from Label table)
      const labelsToday = (settingsData?.labelsToday as number) ?? 0;

      // Calculate success rate only from jobs that actually processed orders
      const jobsWithOrders = jobsData.filter((j) => j.totalOrders > 0);
      const totalOrders = jobsWithOrders.reduce((sum, j) => sum + j.totalOrders, 0);
      const totalSuccess = jobsWithOrders.reduce((sum, j) => sum + j.successCount, 0);
      const successRate = totalOrders > 0 ? Math.round((totalSuccess / totalOrders) * 100) : 0;

      setStats({
        labelsToday,
        labelsMonth: (settingsData?.labelsThisMonth as number) ?? 0,
        successRate,
        lastRunAt: (settingsData?.lastRunAt as string) ?? null,
        shopifyTokenSet: !!(settingsData?.shopifyTokenSet),
        dacPasswordSet: !!(settingsData?.dacPasswordSet),
        emailPassSet: !!(settingsData?.emailPassSet),
        scheduleSlots: (settingsData?.scheduleSlots as ScheduleSlot[] | null) ?? null,
        cronSchedule: (settingsData?.cronSchedule as string | null) ?? null,
        isActive: !!(settingsData?.isActive),
      });

      // Order processing settings
      setOrderSort((settingsData?.orderSortDirection as 'oldest_first' | 'newest_first') ?? 'oldest_first');
      const mode = settingsData?.fulfillMode as string | undefined;
      setFulfillMode(mode === 'off' || mode === 'on' || mode === 'always' ? mode : (settingsData?.autoFulfillEnabled ? 'on' : 'off'));
      const storedAllowed = (settingsData?.allowedProductTypes as string[]) ?? [];
      setAllowedProductTypes(storedAllowed);
      const products = normalizeProductCache(settingsData?.productTypeCache, storedAllowed);
      setAvailableProducts(products);
    } catch {
      // Silent
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Shopify scope probe — runs once on mount (scopes rarely change at
  // runtime; re-running on every fetchData tick would just hammer the
  // Shopify /admin/api/.../access_scopes.json endpoint).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/shopify-scopes');
        if (!res.ok) return; // 400 when Shopify not configured yet — ignore
        const body = await res.json().catch(() => null);
        const missing: string[] = body?.data?.missing ?? [];
        if (!cancelled) setMissingShopifyScopes(missing);
      } catch {
        // Silent — banner just won't appear.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-detect active job on page load and when jobs change
  useEffect(() => {
    if (!activeJobId && jobs.length > 0) {
      const runningJob = jobs.find(j => j.status === 'RUNNING' || j.status === 'PENDING');
      if (runningJob) {
        setActiveJobId(runningJob.id);
      }
    }
  }, [jobs, activeJobId]);

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
      if (!res.ok) {
        setError(data.error ?? 'Error');
      } else if (data.job?.id) {
        setActiveJobId(data.job.id);
      }
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

      {/* Order Processing Controls */}
      <div className="glass rounded-2xl p-4 mb-6 animate-fade-in delay-150">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          {/* Sort direction */}
          <div className="flex items-center gap-2">
            <ArrowUpDown className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs text-zinc-500">Orden:</span>
            <div className="flex items-center gap-1">
              {([
                { value: 'oldest_first' as const, label: 'Antiguos primero' },
                { value: 'newest_first' as const, label: 'Recientes primero' },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  onClick={async () => {
                    setOrderSort(opt.value);
                    setSavingSort(true);
                    try {
                      await fetch('/api/v1/settings', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ orderSortDirection: opt.value }),
                      });
                    } catch { /* silent */ }
                    setSavingSort(false);
                  }}
                  disabled={savingSort}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-all',
                    orderSort === opt.value
                      ? 'bg-cyan-600/20 text-cyan-400 border-cyan-500/30'
                      : 'bg-white/[0.02] text-zinc-500 border-white/[0.04] hover:text-zinc-300 hover:border-white/[0.1]'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="w-px h-6 bg-white/[0.06] hidden sm:block" />

          {/* Fulfill mode selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Preparado:</span>
            <div className="flex rounded-lg overflow-hidden border border-white/[0.06]">
              {([
                { value: 'off' as const, label: 'No', title: 'No marcar como Preparado — solo crea el envio en DAC' },
                { value: 'on' as const, label: 'Si', title: 'Marcar como Preparado si el pedido tiene fulfillment abierto' },
                { value: 'always' as const, label: 'Siempre', title: 'Forzar Preparado siempre, sin importar el producto o estado del pedido' },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  onClick={async () => {
                    if (opt.value === fulfillMode) return;
                    setFulfillMode(opt.value);
                    setSavingFulfill(true);
                    try {
                      await fetch('/api/v1/settings', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fulfillMode: opt.value }),
                      });
                    } catch { /* silent */ }
                    setSavingFulfill(false);
                  }}
                  disabled={savingFulfill}
                  title={opt.title}
                  className={cn(
                    'px-2.5 py-1 text-[11px] font-medium transition-colors',
                    fulfillMode === opt.value
                      ? opt.value === 'off'
                        ? 'bg-zinc-600 text-white'
                        : opt.value === 'on'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-amber-600 text-white'
                      : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="w-px h-6 bg-white/[0.06] hidden sm:block" />

          {/* Product filter — one chip per Shopify product. Whitelist matches
             title / type / vendor case-insensitively in the worker. */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Filter className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
            <span className="text-xs text-zinc-500 flex-shrink-0">Productos:</span>
            {availableProducts.length === 0 ? (
              <button
                onClick={async () => {
                  setScanning(true);
                  setError('');
                  try {
                    const res = await fetch('/api/v1/products/scan', { method: 'POST' });
                    const json = await res.json();
                    if (res.ok && json.data) {
                      const products = (json.data.products ?? []) as typeof availableProducts;
                      setAvailableProducts(products);
                      if (products.length === 0) {
                        setError('No se encontraron productos en Shopify');
                      }
                    } else {
                      setError(json.error ?? 'Error escaneando productos');
                    }
                  } catch {
                    setError('Error de conexion al escanear');
                  }
                  setScanning(false);
                }}
                disabled={scanning}
                className="inline-flex items-center gap-1 text-[11px] text-cyan-400/70 hover:text-cyan-400 transition-colors disabled:opacity-50"
              >
                {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                {scanning ? 'Escaneando...' : 'Escanear Shopify'}
              </button>
            ) : (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={async () => {
                    setAllowedProductTypes([]);
                    try {
                      await fetch('/api/v1/settings', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ allowedProductTypes: null }),
                      });
                    } catch { /* silent */ }
                  }}
                  className={cn(
                    'px-2 py-1 rounded text-[10px] font-medium border transition-all',
                    allowedProductTypes.length === 0
                      ? 'bg-cyan-600/20 text-cyan-400 border-cyan-500/30'
                      : 'bg-white/[0.02] text-zinc-600 border-white/[0.04] hover:text-zinc-400'
                  )}
                >
                  Todos
                </button>
                {availableProducts.map((product) => {
                  const label = product.title || product.type || product.vendor || product.id;
                  const isSelected = allowedProductTypes.includes(label);
                  return (
                    <button
                      key={product.id}
                      title={[product.type, product.vendor].filter(Boolean).join(' · ') || undefined}
                      onClick={async () => {
                        const newTypes = isSelected
                          ? allowedProductTypes.filter((t) => t !== label)
                          : [...allowedProductTypes, label];
                        setAllowedProductTypes(newTypes);
                        try {
                          await fetch('/api/v1/settings', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ allowedProductTypes: newTypes.length > 0 ? newTypes : null }),
                          });
                        } catch { /* silent */ }
                      }}
                      className={cn(
                        'px-2 py-1 rounded text-[10px] font-medium border transition-all max-w-[200px] truncate',
                        isSelected
                          ? 'bg-cyan-600/20 text-cyan-400 border-cyan-500/30'
                          : 'bg-white/[0.02] text-zinc-600 border-white/[0.04] hover:text-zinc-400'
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
                <button
                  onClick={async () => {
                    setScanning(true);
                    try {
                      const res = await fetch('/api/v1/products/scan', { method: 'POST' });
                      if (res.ok) {
                        const { data } = await res.json();
                        setAvailableProducts((data.products ?? []) as typeof availableProducts);
                      }
                    } catch { /* silent */ }
                    setScanning(false);
                  }}
                  disabled={scanning}
                  className="p-1 rounded text-zinc-600 hover:text-cyan-400 transition-colors disabled:opacity-50"
                  title="Re-escanear productos"
                >
                  <RefreshCw className={cn('w-3 h-3', scanning && 'animate-spin')} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Job Feed Panel — appears when a job is active */}
      <JobFeedPanel
        jobId={activeJobId}
        onClose={() => setActiveJobId(null)}
      />

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
        {missingShopifyScopes && missingShopifyScopes.length > 0 && (
          <div className="mt-3 pt-3 border-t border-red-500/20">
            <div className="flex items-start gap-2 text-xs">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-red-300 font-medium">
                  Faltan {missingShopifyScopes.length} scope{missingShopifyScopes.length !== 1 ? 's' : ''} en tu app de Shopify
                </p>
                <p className="text-zinc-400 mt-0.5">
                  Sin estos scopes, el fulfillment automático falla silenciosamente
                  (orden se queda como <em>unfulfilled</em> aunque la guía DAC se haya creado).
                  Reinstalá la app de Shopify con los scopes completos.
                </p>
                <p className="text-zinc-500 mt-1 font-mono text-[10px]">
                  {missingShopifyScopes.join(', ')}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Automatic Schedule Display */}
      {stats?.scheduleSlots && stats.scheduleSlots.length > 0 && (
        <div className="glass rounded-2xl p-5 mb-8 animate-fade-in delay-300">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">Horarios automaticos</h3>
            </div>
            <span className={cn(
              'text-[10px] font-medium px-2 py-0.5 rounded-full',
              stats.isActive
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : 'bg-zinc-500/10 text-zinc-500 border border-zinc-500/20'
            )}>
              {stats.isActive ? 'Activo' : 'Inactivo'}
            </span>
          </div>

          {/* Schedule days from cron */}
          {stats.cronSchedule && (() => {
            const parts = stats.cronSchedule.split(' ');
            if (parts.length < 5) return null;
            const dowField = parts[4];
            const dayNames = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
            let activeDays: number[] = [];
            if (dowField === '*') {
              activeDays = [0, 1, 2, 3, 4, 5, 6];
            } else if (dowField.includes('-')) {
              const [s, e] = dowField.split('-').map(Number);
              for (let i = s; i <= e; i++) activeDays.push(i);
            } else {
              activeDays = dowField.split(',').map(Number);
            }
            return (
              <div className="flex gap-1.5 mb-3">
                {dayNames.map((name, i) => (
                  <span
                    key={i}
                    className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-medium',
                      activeDays.includes(i)
                        ? 'bg-cyan-600/20 text-cyan-400 border border-cyan-500/20'
                        : 'bg-zinc-800/30 text-zinc-700 border border-white/[0.04]'
                    )}
                  >
                    {name}
                  </span>
                ))}
              </div>
            );
          })()}

          {/* Time slots */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {stats.scheduleSlots.map((slot, i) => (
              <div key={i} className="bg-zinc-800/30 border border-white/[0.04] rounded-lg px-3 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                  <span className="text-sm font-medium text-white font-mono">{slot.time}</span>
                </div>
                <span className="text-[10px] text-zinc-500">
                  {slot.maxOrders === 0 ? 'todos' : `max ${slot.maxOrders}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shipment Insights — real-time progress per shipment */}
      <ShipmentInsights />

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

/**
 * Coerces both legacy (string) and current (object) productTypeCache entries
 * into a list of product chips for the filter UI.
 *
 * Legacy entries (pre-2026-04-24) stored a single string per product
 * (typically the vendor name). The new shape is `{ title, type, vendor }`.
 * Both are accepted here so we don't blow up if a tenant hasn't re-scanned
 * yet. Stored allowed entries that no longer correspond to a cached product
 * are appended as orphan chips so the user can still see/remove them.
 */
function normalizeProductCache(
  cache: unknown,
  storedAllowed: string[],
): Array<{ id: string; title: string; type: string; vendor: string }> {
  const out: Array<{ id: string; title: string; type: string; vendor: string }> = [];
  const seen = new Set<string>();
  if (cache && typeof cache === 'object') {
    for (const [id, value] of Object.entries(cache as Record<string, unknown>)) {
      let title = '';
      let type = '';
      let vendor = '';
      if (typeof value === 'string') {
        title = value;
        vendor = value;
      } else if (value && typeof value === 'object') {
        const v = value as { title?: unknown; type?: unknown; vendor?: unknown };
        if (typeof v.title === 'string') title = v.title;
        if (typeof v.type === 'string') type = v.type;
        if (typeof v.vendor === 'string') vendor = v.vendor;
      }
      const label = (title || type || vendor || id).trim();
      if (!label) continue;
      // Dedupe by displayed label so legacy "all-vendor" caches still
      // collapse cleanly while enriched caches keep their per-product rows.
      if (seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      out.push({ id, title: title.trim(), type: type.trim(), vendor: vendor.trim() });
    }
  }
  // Surface stored filters that no longer match a cached product so the
  // user can still toggle them off.
  for (const stored of storedAllowed) {
    const trimmed = stored.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push({ id: `__stored__${trimmed}`, title: trimmed, type: '', vendor: '' });
  }
  return out.sort((a, b) =>
    (a.title || a.type || a.vendor).localeCompare(b.title || b.type || b.vendor, 'es'),
  );
}
