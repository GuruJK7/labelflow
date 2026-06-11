'use client';

/**
 * Centro de Control — multi-store control room.
 *
 * One page to see every store the user owns, how many orders each has pending
 * to complete (live Shopify) and sin completar (retryable), run/retry any store,
 * watch which store is running (and the queue), and filter shipments per store.
 *
 * Data:
 *  - GET /api/v1/control/overview  (DB-only, polled) — stores + wallet + queue
 *  - GET /api/v1/control/pending   (Shopify, throttled) — backlog per store
 *  - POST /api/v1/control/run | /retry — per-store actions (ownership-checked)
 *  - <ShipmentsByStore/> owns the shipments-per-store filter + chart.
 *
 * Matches the app's conventions: fetch + useState + setInterval polling, no
 * TanStack/sonner, hand-rolled Tailwind via cn(), lucide icons, dark + cyan.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Store,
  Play,
  RotateCcw,
  Loader2,
  Package,
  Zap,
  AlertTriangle,
  RefreshCw,
  ListOrdered,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { ShipmentsByStore } from './_components/ShipmentsByStore';

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  shopifyConnected: boolean;
  dacConnected: boolean;
  stuck: { total: number; retryable: number; orphan: number; remitente: number };
  doneToday: number;
  doneMonth: number;
  lastRunAt: string | null;
  maxOrdersPerRun: number;
  running: null | {
    jobId: string;
    status: string;
    trigger: string;
    totalOrders: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    startedAt: string | null;
    leaseActive: boolean;
  };
}
interface Wallet {
  availableCredits: number;
  isActive: boolean;
  subscriptionStatus: string;
}
interface QueueItem {
  position: number;
  jobId: string;
  tenantId: string;
  tenantName: string;
  status: string;
  trigger: string;
  running: boolean;
}
interface Overview {
  stores: StoreRow[];
  wallet: Wallet;
  queue: QueueItem[];
}
interface PendingItem {
  tenantId: string;
  count: number | null;
  cached: boolean;
  skipped: string | null;
}

const BATCH_OPTIONS = [1, 3, 5, 10, 20, 0]; // 0 = Todos
const batchLabel = (n: number) => (n === 0 ? 'Todos' : String(n));

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'nunca';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return 'ahora';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'hace instantes';
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  return `hace ${d}d`;
}

export default function ControlPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pending, setPending] = useState<Record<string, PendingItem>>({});
  const [loadingPending, setLoadingPending] = useState(false);
  const [lote, setLote] = useState(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Record<string, 'run' | 'retry'>>({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const [error, setError] = useState('');
  const [firstLoad, setFirstLoad] = useState(true);

  const anyRunningRef = useRef(false);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/control/overview');
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No se pudo cargar el panel');
        return;
      }
      setOverview(json.data as Overview);
      anyRunningRef.current = (json.data as Overview).queue.some((q) => q.running);
    } catch {
      setError('Error de conexion');
    } finally {
      setFirstLoad(false);
    }
  }, []);

  const fetchPending = useCallback(async (force = false) => {
    setLoadingPending(true);
    try {
      const res = await fetch(`/api/v1/control/pending${force ? '?force=1' : ''}`);
      const json = await res.json();
      if (res.ok) {
        const map: Record<string, PendingItem> = {};
        for (const p of json.data.pending as PendingItem[]) map[p.tenantId] = p;
        setPending(map);
      }
    } catch {
      // pending is best-effort; the DB numbers carry the page.
    } finally {
      setLoadingPending(false);
    }
  }, []);

  // Overview poll — faster while a run is in flight so progress feels live.
  useEffect(() => {
    fetchOverview();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(async () => {
        await fetchOverview();
        tick();
      }, anyRunningRef.current ? 4000 : 10000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [fetchOverview]);

  // Pending (Shopify) — on mount + a slow 2-min refresh; throttled server-side.
  useEffect(() => {
    fetchPending();
    const i = setInterval(() => fetchPending(), 120000);
    return () => clearInterval(i);
  }, [fetchPending]);

  const postRun = useCallback(
    async (tenantId: string, maxOrders: number): Promise<boolean> => {
      const res = await fetch('/api/v1/control/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, maxOrders }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'No se pudo ejecutar la tienda');
        return false;
      }
      return true;
    },
    [],
  );

  const runStore = useCallback(
    async (tenantId: string) => {
      setError('');
      setBusy((b) => ({ ...b, [tenantId]: 'run' }));
      const ok = await postRun(tenantId, lote);
      setBusy((b) => {
        const n = { ...b };
        delete n[tenantId];
        return n;
      });
      if (ok) await fetchOverview();
    },
    [lote, postRun, fetchOverview],
  );

  const retryStore = useCallback(
    async (tenantId: string, retryable: number) => {
      if (retryable <= 0) return;
      const n = Math.min(retryable, 50);
      if (!window.confirm(`Reintentar ${n} envio(s) sin completar de esta tienda? Se reprocesan en DAC.`)) return;
      setError('');
      setBusy((b) => ({ ...b, [tenantId]: 'retry' }));
      try {
        const res = await fetch('/api/v1/control/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantId, count: n }),
        });
        const json = await res.json();
        if (!res.ok) setError(json.error ?? 'No se pudo reintentar');
      } catch {
        setError('Error de conexion');
      }
      setBusy((b) => {
        const x = { ...b };
        delete x[tenantId];
        return x;
      });
      await fetchOverview();
    },
    [fetchOverview],
  );

  const toggleSelect = (tenantId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });

  // Enqueue the selected stores IN DISPLAY ORDER. The single worker drains
  // PENDING jobs by createdAt, so firing them sequentially = run order.
  const runSelected = useCallback(async () => {
    const stores = overview?.stores ?? [];
    const ids = stores.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (ids.length === 0) return;
    setError('');
    setBulkRunning(true);
    for (const id of ids) {
      await postRun(id, lote); // sequential -> strict createdAt order
    }
    setBulkRunning(false);
    setSelected(new Set());
    await fetchOverview();
  }, [overview, selected, lote, postRun, fetchOverview]);

  const stores = overview?.stores ?? [];
  const queue = overview?.queue ?? [];
  const wallet = overview?.wallet;
  const runningByTenant = useMemo(() => {
    const m = new Map<string, StoreRow['running']>();
    for (const s of stores) if (s.running) m.set(s.id, s.running);
    return m;
  }, [stores]);

  const selectedCount = selected.size;

  if (firstLoad && !overview) {
    return (
      <div className="flex items-center justify-center py-32 text-zinc-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Cargando tiendas...
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-xs font-medium tracking-widest text-cyan-400/80 uppercase mb-1 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" /> Centro de Control
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Tus tiendas</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="glass rounded-xl px-4 py-2 text-right">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Envios disponibles</p>
            <p className={cn('text-lg font-bold', (wallet?.availableCredits ?? 0) > 0 ? 'text-emerald-300' : 'text-amber-300')}>
              {wallet?.availableCredits ?? 0}
            </p>
          </div>
          <div className="glass rounded-xl px-4 py-2 text-right">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">Plan</p>
            <p className={cn('text-sm font-semibold', wallet?.isActive ? 'text-emerald-300' : 'text-zinc-400')}>
              {wallet?.isActive ? 'Activo' : 'Inactivo'}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm mb-5 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
          <button onClick={() => setError('')} className="ml-auto text-red-300/60 hover:text-red-300 text-xs">
            cerrar
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="glass rounded-2xl p-4 mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">Lote por corrida:</span>
          <div className="flex rounded-lg overflow-hidden border border-white/[0.07]">
            {BATCH_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => setLote(n)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  lote === n ? 'bg-cyan-500 text-zinc-950' : 'bg-white/[0.02] text-zinc-400 hover:text-white',
                )}
              >
                {batchLabel(n)}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => fetchPending(true)}
          disabled={loadingPending}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.03] border border-white/[0.07] text-zinc-300 hover:text-white hover:border-white/[0.15] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loadingPending && 'animate-spin')} /> Actualizar pendientes
        </button>
        {selectedCount > 0 && (
          <button
            onClick={runSelected}
            disabled={bulkRunning}
            className="ml-auto inline-flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold bg-cyan-500 text-zinc-950 hover:bg-cyan-400 transition-colors disabled:opacity-50"
          >
            {bulkRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListOrdered className="w-3.5 h-3.5" />}
            Ejecutar {selectedCount} en orden
          </button>
        )}
      </div>

      {/* Queue panel */}
      {queue.length > 0 && (
        <div className="glass rounded-2xl p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
            </span>
            <h2 className="text-sm font-semibold text-white">En ejecucion y en cola</h2>
            <span className="text-xs text-zinc-500">{queue.length} en linea</span>
          </div>
          <div className="space-y-2">
            {queue.map((q) => {
              const run = runningByTenant.get(q.tenantId);
              const processed = run ? run.successCount + run.failedCount + run.skippedCount : 0;
              const total = run?.totalOrders ?? 0;
              const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
              return (
                <div
                  key={q.jobId}
                  className={cn(
                    'rounded-xl border px-4 py-3 flex items-center gap-3',
                    q.running ? 'border-cyan-500/30 bg-cyan-500/[0.06]' : 'border-white/[0.06] bg-white/[0.02]',
                  )}
                >
                  <span className={cn('text-xs font-mono w-6 text-center', q.running ? 'text-cyan-300' : 'text-zinc-600')}>
                    {q.running ? '▶' : q.position + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white truncate">{q.tenantName}</p>
                    <p className="text-[11px] text-zinc-500">
                      {q.running
                        ? total > 0
                          ? `Procesando ${processed}/${total}`
                          : 'Iniciando...'
                        : 'En cola'}
                      {' · '}
                      {q.trigger === 'MANUAL' ? 'manual' : q.trigger.toLowerCase()}
                    </p>
                  </div>
                  {q.running && total > 0 && (
                    <div className="w-28 hidden sm:block">
                      <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )}
                  {q.running ? (
                    <Loader2 className="w-4 h-4 text-cyan-300 animate-spin" />
                  ) : (
                    <Clock className="w-4 h-4 text-zinc-600" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stores grid */}
      {stores.length === 0 ? (
        <div className="glass rounded-2xl p-10 text-center text-zinc-500">
          <Store className="w-8 h-8 mx-auto mb-3 opacity-50" />
          No tenes tiendas todavia.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 mb-8">
          {stores.map((s) => (
            <StoreCard
              key={s.id}
              store={s}
              pending={pending[s.id]}
              selected={selected.has(s.id)}
              busy={busy[s.id]}
              loteLabel={batchLabel(lote)}
              onToggleSelect={() => toggleSelect(s.id)}
              onRun={() => runStore(s.id)}
              onRetry={() => retryStore(s.id, s.stuck.retryable)}
            />
          ))}
        </div>
      )}

      {/* Shipments per store */}
      <ShipmentsByStore />
    </div>
  );
}

function StoreCard({
  store,
  pending,
  selected,
  busy,
  loteLabel,
  onToggleSelect,
  onRun,
  onRetry,
}: {
  store: StoreRow;
  pending: PendingItem | undefined;
  selected: boolean;
  busy: 'run' | 'retry' | undefined;
  loteLabel: string;
  onToggleSelect: () => void;
  onRun: () => void;
  onRetry: () => void;
}) {
  const running = store.running;
  const isRunning = !!running;
  const processed = running ? running.successCount + running.failedCount + running.skippedCount : 0;
  const total = running?.totalOrders ?? 0;
  const review = store.stuck.orphan + store.stuck.remitente;
  const pendingCount = pending?.count;

  return (
    <div
      className={cn(
        'glass rounded-2xl p-5 flex flex-col gap-4 transition-colors',
        selected && 'ring-1 ring-cyan-500/40',
        isRunning && 'border-cyan-500/20',
      )}
    >
      {/* header */}
      <div className="flex items-start gap-3">
        <button
          onClick={onToggleSelect}
          aria-label="Seleccionar tienda"
          className={cn(
            'mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border transition-colors',
            selected ? 'bg-cyan-500 border-cyan-500 text-zinc-950' : 'border-white/15 text-transparent hover:border-white/40',
          )}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-white truncate">{store.name}</p>
          <div className="mt-1 flex items-center gap-2 text-[11px]">
            <ConnDot ok={store.shopifyConnected} label="Shopify" />
            <ConnDot ok={store.dacConnected} label="DAC" />
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-500">{timeAgo(store.lastRunAt)}</span>
          </div>
        </div>
        {isRunning && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-semibold text-cyan-300">
            <Loader2 className="w-3 h-3 animate-spin" />
            {total > 0 ? `${processed}/${total}` : 'corriendo'}
          </span>
        )}
      </div>

      {/* metrics */}
      <div className="grid grid-cols-2 gap-3">
        <Metric
          icon={Package}
          label="Para completar"
          value={pendingCount == null ? '—' : pendingCount}
          hint={pending?.skipped === 'no-token' ? 'sin Shopify' : pending?.cached ? 'Shopify' : 'Shopify (live)'}
          tone="cyan"
        />
        <Metric
          icon={AlertTriangle}
          label="Sin completar"
          value={store.stuck.total}
          hint={review > 0 ? `${store.stuck.retryable} reintentar · ${review} revisar` : `${store.stuck.retryable} reintentar`}
          tone={store.stuck.retryable > 0 ? 'amber' : 'zinc'}
        />
        <Metric icon={CheckCircle2} label="Hechos hoy" value={store.doneToday} tone="emerald" />
        <Metric icon={CheckCircle2} label="Este mes" value={store.doneMonth} tone="zinc" />
      </div>

      {/* actions */}
      <div className="flex items-center gap-2 mt-auto pt-1">
        <button
          onClick={onRun}
          disabled={!!busy || isRunning}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold bg-cyan-500 text-zinc-950 hover:bg-cyan-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-1 justify-center"
        >
          {busy === 'run' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {isRunning ? 'En curso' : `Ejecutar ${loteLabel}`}
        </button>
        <button
          onClick={onRetry}
          disabled={!!busy || store.stuck.retryable <= 0}
          title={store.stuck.retryable <= 0 ? 'Nada para reintentar' : `Reintentar ${store.stuck.retryable}`}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-white/[0.03] border border-white/[0.07] text-zinc-300 hover:text-white hover:border-white/[0.15] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === 'retry' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          {store.stuck.retryable > 0 ? store.stuck.retryable : ''}
        </button>
      </div>
    </div>
  );
}

function ConnDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', ok ? 'text-emerald-400/80' : 'text-zinc-600')}>
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-400' : 'bg-zinc-600')} />
      {label}
    </span>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Package;
  label: string;
  value: string | number;
  hint?: string;
  tone: 'cyan' | 'emerald' | 'amber' | 'zinc';
}) {
  const toneClass = {
    cyan: 'text-cyan-300',
    emerald: 'text-emerald-300',
    amber: 'text-amber-300',
    zinc: 'text-zinc-200',
  }[tone];
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <p className={cn('mt-1 text-xl font-bold leading-none', toneClass)}>{value}</p>
      {hint && <p className="mt-1 text-[10px] text-zinc-600 truncate">{hint}</p>}
    </div>
  );
}
