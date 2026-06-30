'use client';

/**
 * Interactive client portal view. Receives already-authorized data as props
 * (the Server Component validated the token and scoped the query). All the
 * interactivity is local: toggle which store(s) to show, search, group by day,
 * and bulk-print. Single PDF downloads hit /api/public/label-pdf; bulk print or
 * download merges the chosen labels into one file via /api/public/label-pdf/bulk
 * so a whole day (or a hand-picked set) prints with a single print dialog.
 *
 * Types come in via `import type` so this client bundle never pulls the
 * server-only lib/client-view module (Prisma + node:crypto).
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Store,
  Calendar,
  Download,
  RefreshCw,
  Search,
  MapPin,
  Hash,
  Truck,
  Package,
  Inbox,
  Printer,
  Loader2,
  CheckSquare,
  Square,
  X,
  ArrowDownUp,
  ArrowUp,
  ArrowDown,
  Receipt,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type {
  ClientViewStore,
  ClientViewLabel,
  ClientViewCounts,
} from '@/lib/client-view';

const TZ = 'America/Montevideo';

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dayLabelFmt = new Intl.DateTimeFormat('es-UY', {
  timeZone: TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('es-UY', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
});
/** Thousands-grouped integers for the billing counter (es-UY uses "." groups). */
const nf = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 });

/** Distinct accent per store. Class strings are literal so Tailwind keeps them. */
const STORE_PALETTE = [
  {
    dot: 'bg-cyan-400',
    text: 'text-cyan-300',
    bar: 'bg-cyan-400',
    chip: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200',
    chipActive: 'border-cyan-400/60 bg-cyan-500/20 text-cyan-50 ring-1 ring-cyan-400/40',
    cardBorder: 'border-cyan-500/20',
  },
  {
    dot: 'bg-violet-400',
    text: 'text-violet-300',
    bar: 'bg-violet-400',
    chip: 'border-violet-400/30 bg-violet-500/10 text-violet-200',
    chipActive: 'border-violet-400/60 bg-violet-500/20 text-violet-50 ring-1 ring-violet-400/40',
    cardBorder: 'border-violet-500/20',
  },
  {
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    bar: 'bg-emerald-400',
    chip: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
    chipActive: 'border-emerald-400/60 bg-emerald-500/20 text-emerald-50 ring-1 ring-emerald-400/40',
    cardBorder: 'border-emerald-500/20',
  },
  {
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    bar: 'bg-amber-400',
    chip: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
    chipActive: 'border-amber-400/60 bg-amber-500/20 text-amber-50 ring-1 ring-amber-400/40',
    cardBorder: 'border-amber-500/20',
  },
] as const;

type StoreColor = (typeof STORE_PALETTE)[number];

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case 'COMPLETED':
      return { label: 'Completada', cls: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300' };
    case 'CREATED':
      return { label: 'Creada', cls: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-300' };
    case 'NEEDS_REVIEW':
      return { label: 'En revisión', cls: 'border-amber-400/30 bg-amber-500/10 text-amber-300' };
    case 'FAILED':
      return { label: 'Con error', cls: 'border-red-400/30 bg-red-500/10 text-red-300' };
    case 'SKIPPED':
      return { label: 'Omitida', cls: 'border-slate-400/30 bg-slate-500/10 text-slate-300' };
    case 'PENDING':
      return { label: 'Pendiente', cls: 'border-slate-400/30 bg-slate-500/10 text-slate-300' };
    default:
      return { label: status, cls: 'border-slate-400/30 bg-slate-500/10 text-slate-300' };
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function locationLabel(l: ClientViewLabel): string {
  const parts = [l.city, l.department].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(', ') : 'Sin localidad';
}

/** Sort keys the client can pick. Default is order number so the cards land in
 * predictable #-order; the rest let the client re-sort a day at a glance. */
type SortKey = 'order' | 'time' | 'city' | 'store' | 'status';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'order', label: 'N° pedido' },
  { key: 'time', label: 'Hora' },
  { key: 'city', label: 'Ciudad' },
  { key: 'store', label: 'Tienda' },
  { key: 'status', label: 'Estado' },
];

/** Numeric value of an order name ("#5630" -> 5630) for sorting. Returns NaN
 * when there is no usable number so the caller can push those to the end. */
function orderNumber(l: ClientViewLabel): number {
  const digits = (l.orderName ?? '').replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : Number.NaN;
}

export function ClientPortal({
  token,
  stores,
  labels,
  counts,
}: {
  token: string;
  stores: ClientViewStore[];
  labels: ClientViewLabel[];
  counts: ClientViewCounts;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('order');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(stores.map((s) => s.id)),
  );

  // Bulk print/download: the set of label ids the client has picked. Only
  // labels that actually have a PDF are ever added here.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState<'print' | 'download' | null>(
    null,
  );
  const [bulkError, setBulkError] = useState<string | null>(null);

  const colorByStore = useMemo(() => {
    const m = new Map<string, StoreColor>();
    stores.forEach((s, i) => m.set(s.id, STORE_PALETTE[i % STORE_PALETTE.length]));
    return m;
  }, [stores]);

  const nameByStore = useMemo(() => {
    const m = new Map<string, string>();
    stores.forEach((s) => m.set(s.id, s.name));
    return m;
  }, [stores]);

  // Comparator for the chosen sort key + direction. Applied WITHIN each day
  // group so the day structure (and "Imprimir día") stays intact. Labels with
  // no order number always fall to the end. Ties break by newest-first so the
  // order is deterministic.
  const sortComparator = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return (a: ClientViewLabel, b: ClientViewLabel): number => {
      let d = 0;
      switch (sortKey) {
        case 'order': {
          const na = orderNumber(a);
          const nb = orderNumber(b);
          if (Number.isNaN(na) && Number.isNaN(nb)) d = 0;
          else if (Number.isNaN(na)) return 1; // a (no number) after b, any dir
          else if (Number.isNaN(nb)) return -1;
          else d = na - nb;
          break;
        }
        case 'city':
          d = locationLabel(a).localeCompare(locationLabel(b), 'es');
          break;
        case 'store':
          d = (nameByStore.get(a.storeId) ?? '').localeCompare(
            nameByStore.get(b.storeId) ?? '',
            'es',
          );
          break;
        case 'status':
          d = statusBadge(a.status).label.localeCompare(
            statusBadge(b.status).label,
            'es',
          );
          break;
        case 'time':
        default:
          d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
      }
      d *= dir;
      if (d === 0) {
        d = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return d;
    };
  }, [sortKey, sortDir, nameByStore]);

  const totalByStore = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of labels) m.set(l.storeId, (m.get(l.storeId) ?? 0) + 1);
    return m;
  }, [labels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return labels.filter((l) => {
      if (!selected.has(l.storeId)) return false;
      if (!q) return true;
      return (
        (l.orderName ?? '').toLowerCase().includes(q) ||
        (l.dacGuia ?? '').toLowerCase().includes(q) ||
        (l.city ?? '').toLowerCase().includes(q) ||
        (l.department ?? '').toLowerCase().includes(q)
      );
    });
  }, [labels, selected, query]);

  const groups = useMemo(() => {
    const map = new Map<string, ClientViewLabel[]>();
    for (const l of filtered) {
      const key = dayKeyFmt.format(new Date(l.createdAt));
      const arr = map.get(key);
      if (arr) arr.push(l);
      else map.set(key, [l]);
    }
    // Sort the cards WITHIN each day by the chosen key + direction.
    for (const arr of map.values()) arr.sort(sortComparator);
    // Newest day first (keys are YYYY-MM-DD, lexicographic == chronological).
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered, sortComparator]);

  // The currently visible, printable labels — what "select all" and Ctrl+A act on.
  const selectableVisibleIds = useMemo(
    () => filtered.filter((l) => l.hasPdf).map((l) => l.id),
    [filtered],
  );

  const selectedCount = selectedIds.size;
  const allVisibleSelected =
    selectableVisibleIds.length > 0 &&
    selectableVisibleIds.every((id) => selectedIds.has(id));

  function toggleStore(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(stores.map((s) => s.id)));
  }

  function toggleLabel(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  /** Toggle a group of ids as a unit: all-on -> clear them, otherwise add all. */
  function toggleGroup(ids: string[]) {
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allOn = ids.every((id) => next.has(id));
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function groupState(ids: string[]): 'none' | 'some' | 'all' {
    if (ids.length === 0) return 'none';
    const on = ids.filter((id) => selectedIds.has(id)).length;
    if (on === 0) return 'none';
    return on === ids.length ? 'all' : 'some';
  }

  function toggleSelectAllVisible() {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(selectableVisibleIds));
  }

  function refresh() {
    startTransition(() => router.refresh());
  }

  function pdfHref(id: string) {
    return `/api/public/label-pdf?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  }

  /**
   * Merge the chosen labels into one PDF and either open it for printing or
   * download it. For printing we open the tab synchronously (inside the click)
   * so the browser doesn't treat the post-fetch window.open as a blocked popup.
   */
  async function handleBulk(mode: 'print' | 'download', idsArg?: string[]) {
    const ids = idsArg ?? Array.from(selectedIds);
    if (ids.length === 0 || bulkLoading) return;

    setBulkError(null);
    setBulkLoading(mode);

    let printWindow: Window | null = null;
    if (mode === 'print') printWindow = window.open('', '_blank');

    try {
      const qs = mode === 'download' ? '?download=true&' : '?';
      const res = await fetch(
        `/api/public/label-pdf/bulk${qs}token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        },
      );

      if (!res.ok) {
        printWindow?.close();
        const msg = await res
          .json()
          .then((j) => (j?.error as string | undefined) ?? undefined)
          .catch(() => undefined);
        setBulkError(msg ?? 'No se pudieron preparar las etiquetas.');
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      if (mode === 'print') {
        // If the synchronous open was blocked, try once more now.
        if (!printWindow) printWindow = window.open(url, '_blank');
        else printWindow.location.href = url;

        if (!printWindow) {
          setBulkError(
            'Permití las ventanas emergentes para imprimir, o usá Descargar.',
          );
        } else {
          const triggerPrint = () => {
            try {
              printWindow?.focus();
              printWindow?.print();
            } catch {
              /* the client can still print manually from the opened tab */
            }
          };
          printWindow.onload = triggerPrint;
          // Fallback in case onload doesn't fire for the blob navigation.
          setTimeout(triggerPrint, 1200);
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = 'etiquetas.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      printWindow?.close();
      setBulkError('Error de conexión al preparar las etiquetas.');
    } finally {
      setBulkLoading(null);
    }
  }

  // Keyboard: Ctrl/Cmd+A selects every visible printable label, Escape clears.
  // Ignored while typing in the search box so normal text editing still works.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        if (selectableVisibleIds.length === 0) return;
        e.preventDefault();
        setSelectedIds(new Set(selectableVisibleIds));
      } else if (e.key === 'Escape') {
        setSelectedIds((prev) => (prev.size ? new Set() : prev));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectableVisibleIds]);

  // Auto-dismiss the transient bulk error.
  useEffect(() => {
    if (!bulkError) return;
    const t = setTimeout(() => setBulkError(null), 6000);
    return () => clearTimeout(t);
  }, [bulkError]);

  const allSelected = selected.size === stores.length;
  const notConfigured = stores.length === 0;

  return (
    <div className="min-h-screen gradient-mesh text-white">
      <div
        className={cn(
          'mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10',
          selectedCount > 0 && 'pb-28',
        )}
      >
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-500/10">
                <Package className="h-5 w-5 text-cyan-300" />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                  Etiquetas
                </h1>
                <p className="text-sm text-white/50">
                  Portal de seguimiento — seleccioná e imprimí
                </p>
              </div>
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50"
          >
            <RefreshCw className={cn('h-4 w-4', isPending && 'animate-spin')} />
            Actualizar
          </button>
        </header>

        {notConfigured ? (
          <div className="glass rounded-2xl p-10 text-center">
            <Inbox className="mx-auto h-10 w-10 text-white/30" />
            <p className="mt-3 text-white/70">
              El portal todavía no está configurado.
            </p>
          </div>
        ) : (
          <>
            {/* Store selector */}
            <section className="mb-5">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-white/40">
                <Store className="h-3.5 w-3.5" />
                Tiendas
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {stores.map((s) => {
                  const color = colorByStore.get(s.id)!;
                  const isOn = selected.has(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggleStore(s.id)}
                      aria-pressed={isOn}
                      className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition',
                        isOn
                          ? color.chipActive
                          : 'border-white/10 bg-white/[0.02] text-white/40 hover:bg-white/[0.05]',
                      )}
                    >
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full',
                          isOn ? color.dot : 'bg-white/20',
                        )}
                      />
                      {s.name}
                      <span
                        className={cn(
                          'rounded-full px-1.5 py-0.5 text-xs',
                          isOn ? 'bg-black/20' : 'bg-white/5 text-white/30',
                        )}
                      >
                        {totalByStore.get(s.id) ?? 0}
                      </span>
                    </button>
                  );
                })}
                {!allSelected && stores.length > 1 && (
                  <button
                    onClick={selectAll}
                    className="rounded-full border border-white/10 px-3 py-1.5 text-sm text-white/50 transition hover:text-white/80"
                  >
                    Ver todas
                  </button>
                )}
              </div>
            </section>

            {/* Billing counter — permanent shipment count (rows, not PDFs), so it
                never drops when old PDFs are purged. For invoicing. */}
            <section className="mb-5">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-white/40">
                <Receipt className="h-3.5 w-3.5" />
                Envíos facturados
              </div>
              <div className="flex flex-wrap items-stretch gap-2">
                {stores.map((s) => {
                  const color = colorByStore.get(s.id)!;
                  const c = counts.byStore[s.id] ?? { total: 0, month: 0 };
                  return (
                    <div
                      key={s.id}
                      className={cn(
                        'rounded-xl border bg-white/[0.03] px-3.5 py-2.5',
                        color.cardBorder,
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={cn('h-2 w-2 rounded-full', color.dot)} />
                        <span className={cn('text-xs font-medium', color.text)}>
                          {s.name}
                        </span>
                      </div>
                      <div className="mt-1 flex items-baseline gap-1.5">
                        <span className="text-xl font-semibold tabular-nums text-white">
                          {nf.format(c.total)}
                        </span>
                        <span className="text-xs text-white/40">en total</span>
                      </div>
                      <div className="text-xs text-white/50">
                        {nf.format(c.month)} este mes
                      </div>
                    </div>
                  );
                })}
                {stores.length > 1 && (
                  <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/[0.08] px-3.5 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Package className="h-3.5 w-3.5 text-cyan-300" />
                      <span className="text-xs font-medium text-cyan-200">Total</span>
                    </div>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="text-xl font-semibold tabular-nums text-white">
                        {nf.format(counts.total)}
                      </span>
                      <span className="text-xs text-white/40">envíos</span>
                    </div>
                    <div className="text-xs text-white/50">
                      {nf.format(counts.month)} este mes
                    </div>
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs text-white/30">
                Envíos con guía DAC emitida. Es un contador permanente: se mantiene
                aunque se borren los PDF viejos.
              </p>
            </section>

            {/* Sort control */}
            <section className="mb-5">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-white/40">
                <ArrowDownUp className="h-3.5 w-3.5" />
                Ordenar por
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {SORT_OPTIONS.map((opt) => {
                  const isOn = sortKey === opt.key;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => setSortKey(opt.key)}
                      aria-pressed={isOn}
                      className={cn(
                        'rounded-full border px-3.5 py-1.5 text-sm font-medium transition',
                        isOn
                          ? 'border-cyan-400/60 bg-cyan-500/20 text-cyan-50 ring-1 ring-cyan-400/40'
                          : 'border-white/10 bg-white/[0.02] text-white/40 hover:bg-white/[0.05]',
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
                <button
                  onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  title={sortDir === 'asc' ? 'Ascendente' : 'Descendente'}
                  aria-label={
                    sortDir === 'asc' ? 'Orden ascendente' : 'Orden descendente'
                  }
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 text-sm text-white/60 transition hover:bg-white/[0.05] hover:text-white/80"
                >
                  {sortDir === 'asc' ? (
                    <ArrowUp className="h-3.5 w-3.5" />
                  ) : (
                    <ArrowDown className="h-3.5 w-3.5" />
                  )}
                  {sortDir === 'asc' ? 'Ascendente' : 'Descendente'}
                </button>
              </div>
            </section>

            {/* Search + summary + select-all */}
            <section className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar por pedido, guía o ciudad"
                  className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-2 pl-9 pr-3 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/40 focus:outline-none focus:ring-1 focus:ring-cyan-400/30"
                />
              </div>
              <div className="flex items-center gap-3">
                {selectableVisibleIds.length > 0 && (
                  <button
                    onClick={toggleSelectAllVisible}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
                      allVisibleSelected
                        ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20'
                        : 'border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.06] hover:text-white/80',
                    )}
                  >
                    {allVisibleSelected ? (
                      <CheckSquare className="h-3.5 w-3.5" />
                    ) : (
                      <Square className="h-3.5 w-3.5" />
                    )}
                    {allVisibleSelected ? 'Quitar selección' : 'Seleccionar todo'}
                  </button>
                )}
                <p className="text-sm text-white/40">
                  <span className="font-semibold text-white/70">{filtered.length}</span>{' '}
                  {filtered.length === 1 ? 'etiqueta' : 'etiquetas'}
                  {groups.length > 0 && (
                    <>
                      {' · '}
                      <span className="font-semibold text-white/70">{groups.length}</span>{' '}
                      {groups.length === 1 ? 'día' : 'días'}
                    </>
                  )}
                </p>
              </div>
            </section>

            {/* Day groups */}
            {groups.length === 0 ? (
              <div className="glass rounded-2xl p-10 text-center">
                <Inbox className="mx-auto h-10 w-10 text-white/30" />
                <p className="mt-3 text-white/70">
                  {labels.length === 0
                    ? 'Todavía no hay etiquetas generadas.'
                    : selected.size === 0
                      ? 'Seleccioná al menos una tienda para ver sus etiquetas.'
                      : 'No hay etiquetas para los filtros actuales.'}
                </p>
              </div>
            ) : (
              <div className="space-y-8">
                {groups.map(([dayKey, items]) => {
                  const date = new Date(items[0].createdAt);
                  const perStore = new Map<string, number>();
                  for (const l of items)
                    perStore.set(l.storeId, (perStore.get(l.storeId) ?? 0) + 1);

                  const dayPdfIds = items
                    .filter((l) => l.hasPdf)
                    .map((l) => l.id);
                  const dayState = groupState(dayPdfIds);

                  return (
                    <section key={dayKey}>
                      {/* Day header */}
                      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/[0.06] pb-2.5">
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-cyan-300" />
                          <h2 className="text-sm font-semibold text-white/90">
                            {cap(dayLabelFmt.format(date))}
                          </h2>
                        </div>
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-white/50">
                          {items.length} {items.length === 1 ? 'etiqueta' : 'etiquetas'}
                        </span>
                        {/* Per-store breakdown for this day */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          {stores
                            .filter((s) => (perStore.get(s.id) ?? 0) > 0)
                            .map((s) => {
                              const color = colorByStore.get(s.id)!;
                              return (
                                <span
                                  key={s.id}
                                  className={cn(
                                    'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs',
                                    color.chip,
                                  )}
                                >
                                  <span className={cn('h-1.5 w-1.5 rounded-full', color.dot)} />
                                  {s.name}: {perStore.get(s.id)}
                                </span>
                              );
                            })}
                        </div>

                        {/* Day actions: select the whole day + print the whole day */}
                        {dayPdfIds.length > 0 && (
                          <div className="ml-auto flex items-center gap-1.5">
                            <button
                              onClick={() => toggleGroup(dayPdfIds)}
                              aria-pressed={dayState === 'all'}
                              className={cn(
                                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
                                dayState === 'none'
                                  ? 'border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.06] hover:text-white/80'
                                  : 'border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20',
                              )}
                            >
                              {dayState === 'all' ? (
                                <CheckSquare className="h-3.5 w-3.5" />
                              ) : (
                                <Square className="h-3.5 w-3.5" />
                              )}
                              {dayState === 'none'
                                ? 'Seleccionar día'
                                : dayState === 'all'
                                  ? 'Quitar día'
                                  : `Día (${dayState === 'some' ? dayPdfIds.filter((id) => selectedIds.has(id)).length : dayPdfIds.length}/${dayPdfIds.length})`}
                            </button>
                            <button
                              onClick={() => handleBulk('print', dayPdfIds)}
                              disabled={bulkLoading !== null}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500 bg-cyan-600 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {bulkLoading === 'print' ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Printer className="h-3.5 w-3.5" />
                              )}
                              Imprimir día
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Cards */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {items.map((l) => {
                          const color = colorByStore.get(l.storeId)!;
                          const badge = statusBadge(l.status);
                          const selectable = l.hasPdf;
                          const isSel = selectedIds.has(l.id);
                          return (
                            <article
                              key={l.id}
                              onClick={
                                selectable ? () => toggleLabel(l.id) : undefined
                              }
                              className={cn(
                                'relative overflow-hidden rounded-xl border bg-white/[0.03] p-4 transition',
                                color.cardBorder,
                                selectable && 'cursor-pointer hover:bg-white/[0.05]',
                                isSel &&
                                  'bg-cyan-500/[0.06] ring-2 ring-cyan-400/60',
                              )}
                            >
                              <span
                                className={cn(
                                  'absolute inset-y-0 left-0 w-1',
                                  color.bar,
                                )}
                              />
                              <div className="flex items-start justify-between gap-2 pl-1.5">
                                <div className="flex min-w-0 items-center gap-2">
                                  {selectable && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleLabel(l.id);
                                      }}
                                      aria-pressed={isSel}
                                      aria-label={
                                        isSel
                                          ? 'Quitar de la selección'
                                          : 'Agregar a la selección'
                                      }
                                      className="shrink-0 rounded-md p-0.5 transition hover:bg-white/10"
                                    >
                                      {isSel ? (
                                        <CheckSquare className="h-4 w-4 text-cyan-300" />
                                      ) : (
                                        <Square className="h-4 w-4 text-white/30" />
                                      )}
                                    </button>
                                  )}
                                  <div className="flex min-w-0 items-center gap-1.5 font-semibold">
                                    <Hash className="h-3.5 w-3.5 shrink-0 text-white/30" />
                                    <span className="truncate">
                                      {l.orderName ?? 'Sin nº'}
                                    </span>
                                  </div>
                                </div>
                                <span
                                  className={cn(
                                    'shrink-0 rounded-full border px-2 py-0.5 text-xs',
                                    badge.cls,
                                  )}
                                >
                                  {badge.label}
                                </span>
                              </div>

                              <div className="mt-2.5 space-y-1.5 pl-1.5 text-sm text-white/60">
                                <div className="flex items-center gap-1.5">
                                  <span className={cn('h-2 w-2 rounded-full', color.dot)} />
                                  <span className={cn('truncate font-medium', color.text)}>
                                    {nameByStore.get(l.storeId) ?? 'Tienda'}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <MapPin className="h-3.5 w-3.5 shrink-0 text-white/30" />
                                  <span className="truncate">{locationLabel(l)}</span>
                                </div>
                                {l.dacGuia && (
                                  <div className="flex items-center gap-1.5">
                                    <Truck className="h-3.5 w-3.5 shrink-0 text-white/30" />
                                    <span className="truncate font-mono text-xs">
                                      DAC {l.dacGuia}
                                    </span>
                                  </div>
                                )}
                              </div>

                              <div className="mt-3 flex items-center justify-between gap-2 pl-1.5">
                                <span className="text-xs text-white/35">
                                  {timeFmt.format(new Date(l.createdAt))}
                                </span>
                                {l.hasPdf ? (
                                  <a
                                    href={pdfHref(l.id)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-500/20"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                    PDF
                                  </a>
                                ) : (
                                  <span className="text-xs text-white/25">Sin PDF</span>
                                )}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}

            <footer className="mt-10 border-t border-white/[0.06] pt-4 text-center text-xs text-white/30">
              Tocá una etiqueta para seleccionarla, o usá “Imprimir día”. Las
              etiquetas se actualizan automáticamente — tocá “Actualizar” para ver
              las más recientes.
            </footer>
          </>
        )}
      </div>

      {/* Transient error toast for bulk actions */}
      {bulkError && (
        <div className="fixed inset-x-0 bottom-24 z-[9999] flex justify-center px-4">
          <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-200 shadow-lg backdrop-blur-xl">
            {bulkError}
          </div>
        </div>
      )}

      {/* Floating bulk action bar */}
      {selectedCount > 0 && (
        <div className="fixed inset-x-0 bottom-5 z-[9999] flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-2xl border border-cyan-500/20 bg-zinc-900/95 px-4 py-3 shadow-2xl shadow-cyan-500/10 backdrop-blur-xl">
            <div className="flex items-center gap-2 border-r border-white/10 pr-3">
              <span className="text-sm font-semibold text-white">
                {selectedCount}
              </span>
              <span className="text-xs text-white/50">
                {selectedCount === 1 ? 'seleccionada' : 'seleccionadas'}
              </span>
            </div>
            <button
              onClick={clearSelection}
              title="Limpiar selección"
              className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/5 hover:text-white/80"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              onClick={() => handleBulk('download')}
              disabled={bulkLoading !== null}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2 text-xs font-medium text-white/80 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkLoading === 'download' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Descargar
            </button>
            <button
              onClick={() => handleBulk('print')}
              disabled={bulkLoading !== null}
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-500 bg-cyan-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkLoading === 'print' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Printer className="h-3.5 w-3.5" />
              )}
              Imprimir
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
