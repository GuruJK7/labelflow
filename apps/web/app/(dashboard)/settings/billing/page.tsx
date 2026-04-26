'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Check,
  AlertCircle,
  Clock,
  Wallet,
  Gift,
  Package,
  TrendingDown,
  Zap,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';

interface Pack {
  id: string;
  shipments: number;
  pricePerShipmentUyu: number;
  totalPriceUyu: number;
  label: string;
}

interface CreditState {
  balance: {
    shipmentCredits: number;
    creditsPurchased: number;
    creditsConsumed: number;
    referralCreditsEarned: number;
  };
  packs: Pack[];
  recentPurchases: Array<{
    id: string;
    packId: string;
    shipments: number;
    totalPriceUyu: number;
    status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';
    paidAt: string | null;
    createdAt: string;
  }>;
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="text-zinc-500 text-sm p-8">Cargando...</div>}>
      <BillingContent />
    </Suspense>
  );
}

function BillingContent() {
  const searchParams = useSearchParams();
  const [state, setState] = useState<CreditState | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const success = searchParams.get('success') === 'true';
  const error = searchParams.get('error') === 'true';
  const pending = searchParams.get('pending') === 'true';

  useEffect(() => {
    fetch('/api/credit-packs/me')
      .then((r) => r.json())
      .then(({ data }) => setState(data))
      .catch(() => {});
  }, []);

  function handleBuy(packId: string) {
    setLoading(packId);
    window.location.href = `/api/credit-packs/checkout?pack=${packId}`;
  }

  const balance = state?.balance;
  const packs = state?.packs ?? [];
  const recentPurchases = state?.recentPurchases ?? [];

  // Reference price (smallest pack) for "you save" calculations
  const refPrice = packs.find((p) => p.id === 'pack_10')?.pricePerShipmentUyu ?? 20;

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-10">
        <div className="flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-widest mb-3">
          <Zap className="w-3.5 h-3.5" />
          Envíos prepagos
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-white tracking-tight">
          Comprá envíos. <span className="text-zinc-500">Pagás solo por lo que usás.</span>
        </h1>
        <p className="text-zinc-400 text-sm mt-2 max-w-2xl">
          Sin suscripciones, sin caducidad. Cuanto más comprás, menos pagás por envío.
        </p>
      </div>

      {/* Banners */}
      {success && (
        <div className="bg-gradient-to-r from-emerald-500/10 to-emerald-500/5 border border-emerald-500/20 rounded-2xl p-4 mb-6 flex items-center gap-3 backdrop-blur-sm">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <Check className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-300">Pago acreditado</p>
            <p className="text-xs text-emerald-400/70 mt-0.5">
              Tus envíos ya están disponibles. Si tardan unos segundos, recargá la página.
            </p>
          </div>
        </div>
      )}
      {error && (
        <div className="bg-gradient-to-r from-red-500/10 to-red-500/5 border border-red-500/20 rounded-2xl p-4 mb-6 flex items-center gap-3 backdrop-blur-sm">
          <div className="w-9 h-9 rounded-xl bg-red-500/20 flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-red-300">Error en el pago</p>
            <p className="text-xs text-red-400/70 mt-0.5">
              No se pudo procesar el pago. Probá nuevamente o usá otro medio.
            </p>
          </div>
        </div>
      )}
      {pending && (
        <div className="bg-gradient-to-r from-yellow-500/10 to-yellow-500/5 border border-yellow-500/20 rounded-2xl p-4 mb-6 flex items-center gap-3 backdrop-blur-sm">
          <div className="w-9 h-9 rounded-xl bg-yellow-500/20 flex items-center justify-center flex-shrink-0">
            <Clock className="w-5 h-5 text-yellow-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-yellow-300">Pago pendiente</p>
            <p className="text-xs text-yellow-400/70 mt-0.5">
              MercadoPago está procesando. Vas a ver los envíos acreditados al confirmarse.
            </p>
          </div>
        </div>
      )}

      {/* Hero balance */}
      <div className="relative overflow-hidden rounded-3xl mb-6 group">
        {/* Glow background */}
        <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/20 via-cyan-500/5 to-transparent" />
        <div className="absolute -top-24 -right-24 w-80 h-80 bg-cyan-500/20 rounded-full blur-3xl" />
        <div className="absolute inset-0 bg-zinc-900/40 backdrop-blur-xl" />
        <div className="relative border border-cyan-500/20 rounded-3xl p-8">
          <div className="flex items-start justify-between flex-wrap gap-6">
            <div>
              <div className="flex items-center gap-2 text-cyan-300/80 text-xs font-medium uppercase tracking-widest mb-2">
                <Wallet className="w-3.5 h-3.5" />
                Saldo actual
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-6xl md:text-7xl font-bold tabular-nums bg-gradient-to-br from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                  {(balance?.shipmentCredits ?? 0).toLocaleString('es-UY')}
                </span>
                <span className="text-xl font-medium text-zinc-400">envíos</span>
              </div>
              <p className="text-xs text-zinc-500 mt-2">
                Disponibles para procesar pedidos automáticamente
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="#packs"
                className="group/btn relative inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-zinc-950 text-sm font-semibold transition-all shadow-lg shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:-translate-y-0.5"
              >
                <Sparkles className="w-4 h-4" />
                Recargar
              </a>
            </div>
          </div>

          {/* Mini stats inline */}
          <div className="grid grid-cols-3 gap-4 mt-8 pt-6 border-t border-white/[0.06]">
            <MiniStat
              icon={<Package className="w-3.5 h-3.5" />}
              label="Comprados"
              value={balance?.creditsPurchased ?? 0}
            />
            <MiniStat
              icon={<Check className="w-3.5 h-3.5" />}
              label="Usados"
              value={balance?.creditsConsumed ?? 0}
            />
            <MiniStat
              icon={<Gift className="w-3.5 h-3.5" />}
              label="Referidos"
              value={balance?.referralCreditsEarned ?? 0}
              accent
            />
          </div>
        </div>
      </div>

      {/* Packs section title */}
      <div id="packs" className="flex items-end justify-between mb-5 mt-12">
        <div>
          <h2 className="text-xl font-bold text-white">Elegí tu pack</h2>
          <p className="text-zinc-500 text-sm mt-1">
            Sin caducidad. Pago único con MercadoPago.
          </p>
        </div>
        <div className="hidden md:flex items-center gap-2 text-xs text-zinc-500">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          Pago seguro
        </div>
      </div>

      {/* Packs grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-12 pt-4">
        {packs.map((pack) => {
          const isPopular = pack.id === 'pack_100';
          const isBest = pack.id === 'pack_1000';
          const isLoading = loading === pack.id;
          const savings =
            refPrice > 0 && pack.pricePerShipmentUyu < refPrice
              ? Math.round(((refPrice - pack.pricePerShipmentUyu) / refPrice) * 100)
              : 0;

          return (
            <div
              key={pack.id}
              className={`group relative rounded-2xl transition-all duration-300 hover:-translate-y-1 ${
                isBest
                  ? 'shadow-2xl shadow-amber-500/10 hover:shadow-amber-500/20'
                  : isPopular
                    ? 'shadow-2xl shadow-cyan-500/10 hover:shadow-cyan-500/20'
                    : 'hover:shadow-xl hover:shadow-cyan-500/5'
              }`}
            >
              {/* Animated gradient border for highlighted packs */}
              {(isBest || isPopular) && (
                <div
                  className={`absolute inset-0 rounded-2xl opacity-60 group-hover:opacity-100 transition-opacity pointer-events-none ${
                    isBest
                      ? 'bg-gradient-to-br from-amber-500/40 via-orange-500/20 to-amber-500/40'
                      : 'bg-gradient-to-br from-cyan-500/40 via-cyan-400/20 to-cyan-500/40'
                  }`}
                />
              )}
              {/* Card body */}
              <div
                className={`relative m-[1px] rounded-2xl p-6 h-full flex flex-col ${
                  isBest || isPopular
                    ? 'bg-zinc-950/95'
                    : 'bg-zinc-900/50 border border-white/[0.06] group-hover:border-white/[0.12]'
                } backdrop-blur-xl transition-colors`}
              >
                {/* Ribbon */}
                {isPopular && !isBest && (
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
                    <div className="bg-gradient-to-r from-cyan-500 to-cyan-400 text-zinc-950 text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider shadow-lg shadow-cyan-500/40 whitespace-nowrap">
                      Más popular
                    </div>
                  </div>
                )}
                {isBest && (
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
                    <div className="bg-gradient-to-r from-amber-500 to-orange-400 text-zinc-950 text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider shadow-lg shadow-amber-500/40 whitespace-nowrap">
                      Mejor precio
                    </div>
                  </div>
                )}

                {/* Savings badge */}
                {savings > 0 && (
                  <div className="absolute top-4 right-4 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-semibold">
                    <TrendingDown className="w-3 h-3" />
                    -{savings}%
                  </div>
                )}

                {/* Quantity */}
                <div className="text-center mb-1 mt-2">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-900 border border-white/[0.06] mb-3">
                    <Package
                      className={`w-5 h-5 ${
                        isBest
                          ? 'text-amber-400'
                          : isPopular
                            ? 'text-cyan-400'
                            : 'text-zinc-400'
                      }`}
                    />
                  </div>
                  <p className="text-3xl font-bold text-white tabular-nums">
                    {pack.shipments.toLocaleString('es-UY')}
                  </p>
                  <p className="text-xs text-zinc-500 uppercase tracking-wider mt-0.5">envíos</p>
                </div>

                {/* Price */}
                <div className="text-center my-5 py-4 border-y border-white/[0.04]">
                  <div className="flex items-baseline justify-center gap-1.5">
                    <span className="text-zinc-500 text-sm">$</span>
                    <span className="text-4xl font-bold text-white tabular-nums tracking-tight">
                      {pack.totalPriceUyu.toLocaleString('es-UY')}
                    </span>
                    <span className="text-xs text-zinc-500 font-medium">UYU</span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-2">
                    <span className="text-cyan-400 font-semibold">
                      ${pack.pricePerShipmentUyu}
                    </span>{' '}
                    UYU por envío
                  </p>
                </div>

                {/* CTA */}
                <button
                  onClick={() => handleBuy(pack.id)}
                  disabled={isLoading}
                  className={`block w-full text-center py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-wait mt-auto ${
                    isBest
                      ? 'bg-gradient-to-r from-amber-500 to-orange-400 hover:from-amber-400 hover:to-orange-300 text-zinc-950 shadow-lg shadow-amber-500/20 hover:shadow-amber-500/40'
                      : isPopular
                        ? 'bg-gradient-to-r from-cyan-500 to-cyan-400 hover:from-cyan-400 hover:to-cyan-300 text-zinc-950 shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40'
                        : 'bg-white/[0.04] hover:bg-white/[0.08] text-white border border-white/[0.08] hover:border-cyan-500/30'
                  }`}
                >
                  {isLoading ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="w-3.5 h-3.5 border-2 border-current border-r-transparent rounded-full animate-spin" />
                      Redirigiendo...
                    </span>
                  ) : (
                    'Comprar pack'
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Historial */}
      {recentPurchases.length > 0 && (
        <div className="bg-zinc-900/40 border border-white/[0.06] rounded-2xl p-6 mb-8 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-zinc-800 border border-white/[0.06] flex items-center justify-center">
                <Clock className="w-4 h-4 text-zinc-400" />
              </div>
              <h2 className="text-base font-semibold text-white">Historial de compras</h2>
            </div>
            <span className="text-xs text-zinc-500">
              {recentPurchases.length} compra{recentPurchases.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                  <th className="text-left pb-3 px-2 font-medium">Fecha</th>
                  <th className="text-left pb-3 px-2 font-medium">Pack</th>
                  <th className="text-right pb-3 px-2 font-medium">Envíos</th>
                  <th className="text-right pb-3 px-2 font-medium">Total</th>
                  <th className="text-right pb-3 px-2 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {recentPurchases.map((p) => (
                  <tr
                    key={p.id}
                    className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="py-3 px-2 text-zinc-400">
                      {new Date(p.paidAt ?? p.createdAt).toLocaleDateString('es-UY', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-3 px-2 font-mono text-xs text-zinc-300">{p.packId}</td>
                    <td className="py-3 px-2 text-right tabular-nums font-medium">
                      +{p.shipments}
                    </td>
                    <td className="py-3 px-2 text-right tabular-nums">
                      ${p.totalPriceUyu.toLocaleString('es-UY')}{' '}
                      <span className="text-zinc-500 text-xs">UYU</span>
                    </td>
                    <td className="py-3 px-2 text-right">
                      <PurchaseStatus status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
        <div className="bg-zinc-900/30 border border-white/[0.04] rounded-xl p-4 flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-xs font-semibold text-zinc-300">Pago seguro</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Procesado por MercadoPago
            </p>
          </div>
        </div>
        <div className="bg-zinc-900/30 border border-white/[0.04] rounded-xl p-4 flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center flex-shrink-0">
            <Clock className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <p className="text-xs font-semibold text-zinc-300">Sin caducidad</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">Tus envíos no expiran</p>
          </div>
        </div>
        <div className="bg-zinc-900/30 border border-white/[0.04] rounded-xl p-4 flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <p className="text-xs font-semibold text-zinc-300">Sin suscripción</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">Pagás solo lo que usás</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">
        {icon}
        {label}
      </div>
      <p
        className={`text-xl font-semibold tabular-nums ${
          accent ? 'text-emerald-400' : 'text-zinc-200'
        }`}
      >
        {value.toLocaleString('es-UY')}
      </p>
    </div>
  );
}

function PurchaseStatus({ status }: { status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' }) {
  const map = {
    PAID: {
      label: 'Pagado',
      cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      dot: 'bg-emerald-400',
    },
    PENDING: {
      label: 'Pendiente',
      cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
      dot: 'bg-yellow-400',
    },
    FAILED: {
      label: 'Rechazado',
      cls: 'bg-red-500/10 text-red-400 border-red-500/20',
      dot: 'bg-red-400',
    },
    REFUNDED: {
      label: 'Reembolsado',
      cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
      dot: 'bg-zinc-400',
    },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${m.cls}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}
