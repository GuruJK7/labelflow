'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  ShoppingCart,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Filter,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RecoverCart, CartStatus } from '@/types/recover';

const STATUS_LABELS: Record<CartStatus, string> = {
  PENDING: 'Pendiente',
  MESSAGE_1_SENT: 'Msg 1 enviado',
  MESSAGE_2_SENT: 'Msg 2 enviado',
  RECOVERED: 'Recuperado',
  OPTED_OUT: 'Opt-out',
  NO_PHONE: 'Sin telefono',
  FAILED: 'Fallido',
};

const STATUS_COLORS: Record<CartStatus, string> = {
  PENDING: 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20',
  MESSAGE_1_SENT: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  MESSAGE_2_SENT: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
  RECOVERED: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  OPTED_OUT: 'text-red-400 bg-red-400/10 border-red-400/20',
  NO_PHONE: 'text-orange-400 bg-orange-400/10 border-orange-400/20',
  FAILED: 'text-red-400 bg-red-400/10 border-red-400/20',
};

const FILTERS: { label: string; value: CartStatus | 'all' }[] = [
  { label: 'Todos', value: 'all' },
  { label: 'Pendientes', value: 'PENDING' },
  { label: 'Enviados', value: 'MESSAGE_1_SENT' },
  { label: 'Recuperados', value: 'RECOVERED' },
  { label: 'Sin telefono', value: 'NO_PHONE' },
  { label: 'Opt-out', value: 'OPTED_OUT' },
  { label: 'Fallidos', value: 'FAILED' },
];

function maskPhone(phone: string | null): string {
  if (!phone) return '—';
  if (phone.length < 8) return '***';
  return `${phone.slice(0, 6)}${'*'.repeat(Math.max(phone.length - 8, 3))}${phone.slice(-2)}`;
}

function formatDate(dateStr: string | Date): string {
  return new Date(dateStr).toLocaleString('es-UY', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getProductSummary(cartItems: unknown): string {
  const items = cartItems as Array<{ title: string; quantity: number }>;
  if (!Array.isArray(items) || items.length === 0) return '—';
  const first = items[0]?.title ?? '—';
  if (items.length === 1) return first;
  return `${first} y ${items.length - 1} mas`;
}

export default function RecoverCartsPage() {
  const [carts, setCarts] = useState<RecoverCart[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<CartStatus | 'all'>('all');

  const LIMIT = 20;

  const fetchCarts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(LIMIT),
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      });

      const res = await fetch(`/api/recover/carts?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setCarts(data.data ?? []);
        setTotal(data.meta?.total ?? 0);
        setPages(data.meta?.pages ?? 1);
      }
    } catch {
      // Silent
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    fetchCarts();
  }, [fetchCarts]);

  // Reset page when filter changes
  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Carritos abandonados</h1>
          <p className="text-zinc-500 text-sm mt-1">
            {total} carrito{total !== 1 ? 's' : ''} registrado{total !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={async () => {
            setSyncing(true);
            try {
              await fetch('/api/recover/sync', { method: 'POST' });
              fetchCarts();
            } catch { /* silent */ }
            setSyncing(false);
          }}
          disabled={syncing}
          className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-cyan-400 text-xs font-medium hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', syncing && 'animate-spin')} />
          {syncing ? 'Sincronizando...' : 'Sincronizar Shopify'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1 flex-wrap">
        <Filter className="w-3.5 h-3.5 text-zinc-600 mr-1" />
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
              statusFilter === f.value
                ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
                : 'bg-white/[0.02] text-zinc-500 border-white/[0.06] hover:text-zinc-300'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
          </div>
        ) : carts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ShoppingCart className="w-8 h-8 text-zinc-700 mb-3" />
            <p className="text-zinc-500 text-sm">No hay carritos con este filtro</p>
          </div>
        ) : (
          <>
            {/* Table header */}
            <div className="grid grid-cols-[2fr_2fr_1fr_1fr_1fr] gap-4 px-5 py-3 border-b border-white/[0.06] text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              <span>Cliente</span>
              <span>Productos</span>
              <span>Total</span>
              <span>Estado</span>
              <span>Fecha</span>
            </div>

            {/* Rows */}
            <div className="divide-y divide-white/[0.04]">
              {carts.map((cart) => (
                <div
                  key={cart.id}
                  className="grid grid-cols-[2fr_2fr_1fr_1fr_1fr] gap-4 px-5 py-3.5 items-center hover:bg-white/[0.01] transition-colors"
                >
                  {/* Cliente */}
                  <div>
                    <p className="text-sm text-white font-medium truncate">
                      {cart.customerName ?? 'Desconocido'}
                    </p>
                    <p className="text-xs text-zinc-600 font-mono">
                      {maskPhone(cart.customerPhone)}
                    </p>
                  </div>

                  {/* Productos */}
                  <p className="text-xs text-zinc-400 truncate">
                    {getProductSummary(cart.cartItems)}
                  </p>

                  {/* Total */}
                  <p className="text-sm text-zinc-300">
                    ${cart.cartTotal?.toLocaleString('es-UY') ?? '0'}
                  </p>

                  {/* Estado */}
                  <span
                    className={cn(
                      'inline-flex px-2 py-0.5 text-[10px] font-semibold rounded-full border w-fit',
                      STATUS_COLORS[cart.status]
                    )}
                  >
                    {STATUS_LABELS[cart.status]}
                  </span>

                  {/* Fecha */}
                  <p className="text-xs text-zinc-600">{formatDate(cart.createdAt)}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-600">
            Pagina {page} de {pages} ({total} total)
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-1.5 rounded-lg border border-white/[0.06] text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page === pages}
              className="p-1.5 rounded-lg border border-white/[0.06] text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
