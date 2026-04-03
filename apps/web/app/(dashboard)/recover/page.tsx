'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  MessageSquare,
  ShoppingCart,
  TrendingUp,
  DollarSign,
  Users,
  ToggleLeft,
  ToggleRight,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  PhoneOff,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RecoverConfig, RecoverStats, RecoverCart, CartStatus } from '@/types/recover';

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

function maskPhone(phone: string | null): string {
  if (!phone) return '—';
  if (phone.length < 8) return '***';
  return `${phone.slice(0, 6)}${'*'.repeat(Math.max(phone.length - 8, 3))}${phone.slice(-2)}`;
}

export default function RecoverPage() {
  const [config, setConfig] = useState<RecoverConfig | null>(null);
  const [stats, setStats] = useState<RecoverStats | null>(null);
  const [recentCarts, setRecentCarts] = useState<RecoverCart[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('30d');

  const fetchData = useCallback(async () => {
    try {
      const [configRes, statsRes, cartsRes] = await Promise.all([
        fetch('/api/recover/config'),
        fetch(`/api/recover/stats?period=${period}`),
        fetch('/api/recover/carts?limit=5'),
      ]);

      if (configRes.ok) {
        const res = await configRes.json();
        setConfig(res.data);
      }
      if (statsRes.ok) {
        const res = await statsRes.json();
        setStats(res.data);
      }
      if (cartsRes.ok) {
        const res = await cartsRes.json();
        setRecentCarts(res.data ?? []);
      }
    } catch {
      // Silent
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleToggleActive() {
    if (!config || config.subscriptionStatus !== 'ACTIVE') return;
    setToggling(true);
    try {
      const res = await fetch('/api/recover/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !config.isActive }),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig(data.data);
      }
    } catch {
      // Silent
    } finally {
      setToggling(false);
    }
  }

  const isSubscribed = config?.subscriptionStatus === 'ACTIVE';
  const isActive = config?.isActive && isSubscribed;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">AutoEnvia Recover</h1>
          <span
            className={cn(
              'px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full border',
              isActive
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
            )}
          >
            {isActive ? 'Activo' : isSubscribed ? 'Inactivo' : 'Sin suscripcion'}
          </span>
        </div>

        {/* Period selector */}
        <div className="flex items-center gap-1 bg-white/[0.03] border border-white/[0.06] rounded-lg p-1">
          {(['7d', '30d', 'all'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                period === p
                  ? 'bg-cyan-500/10 text-cyan-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              )}
            >
              {p === '7d' ? '7 dias' : p === '30d' ? '30 dias' : 'Todo'}
            </button>
          ))}
        </div>
      </div>

      {/* Activation banner */}
      {!isSubscribed && (
        <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-5 flex items-center justify-between">
          <div>
            <p className="text-white font-semibold text-sm mb-1">
              Activa AutoEnvia Recover para recuperar carritos abandonados
            </p>
            <p className="text-zinc-400 text-xs">
              Envia mensajes de WhatsApp automaticos a clientes que no completaron su compra.
            </p>
          </div>
          <a
            href="/recover/settings"
            className="flex-shrink-0 ml-4 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            Ver planes
          </a>
        </div>
      )}

      {/* Toggle */}
      {isSubscribed && (
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5 flex items-center justify-between">
          <div>
            <p className="text-white font-medium text-sm">Modulo activo</p>
            <p className="text-zinc-500 text-xs mt-0.5">
              {isActive
                ? 'El sistema detecta y recupera carritos abandonados automaticamente.'
                : 'Activa el modulo para empezar a recuperar carritos.'}
            </p>
          </div>
          <button
            onClick={handleToggleActive}
            disabled={toggling}
            className="flex items-center gap-2 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {toggling ? (
              <Loader2 className="w-5 h-5 text-zinc-400 animate-spin" />
            ) : isActive ? (
              <ToggleRight className="w-8 h-8 text-cyan-400" />
            ) : (
              <ToggleLeft className="w-8 h-8 text-zinc-600" />
            )}
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<ShoppingCart className="w-4 h-4" />}
          label="Carritos detectados"
          value={stats?.totalDetected ?? 0}
          color="text-zinc-400"
        />
        <StatCard
          icon={<MessageSquare className="w-4 h-4" />}
          label="Mensajes enviados"
          value={stats?.totalSent ?? 0}
          color="text-blue-400"
        />
        <StatCard
          icon={<CheckCircle className="w-4 h-4" />}
          label="Carritos recuperados"
          value={stats?.totalRecovered ?? 0}
          color="text-emerald-400"
        />
        <StatCard
          icon={<DollarSign className="w-4 h-4" />}
          label="Revenue recuperado"
          value={`$${(stats?.revenueRecovered ?? 0).toLocaleString('es-UY')}`}
          color="text-cyan-400"
        />
      </div>

      {/* Recovery rate */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-cyan-400" />
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wide">
              Tasa de recuperacion
            </span>
          </div>
          <p className="text-3xl font-bold text-white">
            {stats?.recoveryRate.toFixed(1) ?? '0.0'}%
          </p>
          <p className="text-xs text-zinc-600 mt-1">de carritos con mensaje enviado</p>
        </div>
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-red-400" />
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wide">
              Opt-outs
            </span>
          </div>
          <p className="text-3xl font-bold text-white">{stats?.totalOptedOut ?? 0}</p>
          <p className="text-xs text-zinc-600 mt-1">clientes que enviaron STOP</p>
        </div>
      </div>

      {/* Recent carts */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white">Ultimos carritos</h2>
          <a
            href="/recover/carts"
            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            Ver todos
          </a>
        </div>

        {recentCarts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <ShoppingCart className="w-8 h-8 text-zinc-700 mb-3" />
            <p className="text-zinc-500 text-sm">No hay carritos registrados aun</p>
            <p className="text-zinc-700 text-xs mt-1">
              Los carritos apareceran cuando Shopify envie el webhook
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {recentCarts.map((cart) => (
              <div
                key={cart.id}
                className="flex items-center justify-between px-5 py-3 hover:bg-white/[0.02] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-white/[0.04] rounded-lg flex items-center justify-center">
                    <ShoppingCart className="w-3.5 h-3.5 text-zinc-500" />
                  </div>
                  <div>
                    <p className="text-sm text-white font-medium">
                      {cart.customerName ?? 'Cliente'}
                    </p>
                    <p className="text-xs text-zinc-600">{maskPhone(cart.customerPhone)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400">
                    ${cart.cartTotal?.toLocaleString('es-UY') ?? '0'} {cart.currency}
                  </span>
                  <span
                    className={cn(
                      'px-2 py-0.5 text-[10px] font-semibold rounded-full border',
                      STATUS_COLORS[cart.status]
                    )}
                  >
                    {STATUS_LABELS[cart.status]}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
      <div className={cn('flex items-center gap-2 mb-3', color)}>
        {icon}
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          {label}
        </span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}
