'use client';

/**
 * Interactive client portal view. Receives already-authorized data as props
 * (the Server Component validated the token and scoped the query). All the
 * interactivity is local: toggle which store(s) to show, search, and group by
 * day. PDF downloads hit the token-gated /api/public/label-pdf endpoint.
 *
 * Types come in via `import type` so this client bundle never pulls the
 * server-only lib/client-view module (Prisma + node:crypto).
 */

import { useMemo, useState, useTransition } from 'react';
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
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ClientViewStore, ClientViewLabel } from '@/lib/client-view';

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

export function ClientPortal({
  token,
  stores,
  labels,
}: {
  token: string;
  stores: ClientViewStore[];
  labels: ClientViewLabel[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(stores.map((s) => s.id)),
  );

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
    // Newest day first (keys are YYYY-MM-DD, lexicographic == chronological).
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

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

  function refresh() {
    startTransition(() => router.refresh());
  }

  function pdfHref(id: string) {
    return `/api/public/label-pdf?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  }

  const allSelected = selected.size === stores.length;
  const notConfigured = stores.length === 0;

  return (
    <div className="min-h-screen gradient-mesh text-white">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
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
                  Portal de seguimiento — solo lectura
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

            {/* Search + summary */}
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
                      </div>

                      {/* Cards */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {items.map((l) => {
                          const color = colorByStore.get(l.storeId)!;
                          const badge = statusBadge(l.status);
                          return (
                            <article
                              key={l.id}
                              className={cn(
                                'relative overflow-hidden rounded-xl border bg-white/[0.03] p-4 transition hover:bg-white/[0.05]',
                                color.cardBorder,
                              )}
                            >
                              <span
                                className={cn(
                                  'absolute inset-y-0 left-0 w-1',
                                  color.bar,
                                )}
                              />
                              <div className="flex items-start justify-between gap-2 pl-1.5">
                                <div className="flex items-center gap-1.5 font-semibold">
                                  <Hash className="h-3.5 w-3.5 text-white/30" />
                                  <span className="truncate">
                                    {l.orderName ?? 'Sin nº'}
                                  </span>
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
              Las etiquetas se actualizan automáticamente. Tocá “Actualizar” para
              ver las más recientes.
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
