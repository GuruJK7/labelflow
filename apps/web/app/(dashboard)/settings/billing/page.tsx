'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, AlertCircle, Clock, Wallet, Gift, Package } from 'lucide-react';

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

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Envíos</h1>
        <p className="text-zinc-500 text-sm mt-1">
          Comprá packs de envíos. Pagás solo por lo que usás. Sin suscripciones.
        </p>
      </div>

      {/* Banners */}
      {success && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 mb-6 flex items-center gap-3">
          <Check className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-emerald-400">Pago acreditado</p>
            <p className="text-xs text-emerald-400/70 mt-0.5">
              Tus envíos ya están disponibles. Si tardan unos segundos, recargá la página.
            </p>
          </div>
        </div>
      )}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-400">Error en el pago</p>
            <p className="text-xs text-red-400/70 mt-0.5">
              No se pudo procesar el pago. Probá nuevamente o usá otro medio.
            </p>
          </div>
        </div>
      )}
      {pending && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 mb-6 flex items-center gap-3">
          <Clock className="w-5 h-5 text-yellow-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-yellow-400">Pago pendiente</p>
            <p className="text-xs text-yellow-400/70 mt-0.5">
              MercadoPago está procesando. Vas a ver los envíos acreditados al confirmarse.
            </p>
          </div>
        </div>
      )}

      {/* Balance */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6 mb-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <BalanceCard
            icon={<Wallet className="w-4 h-4" />}
            label="Saldo actual"
            value={balance?.shipmentCredits ?? 0}
            unit="envíos"
            highlight
          />
          <BalanceCard
            icon={<Package className="w-4 h-4" />}
            label="Comprados (total)"
            value={balance?.creditsPurchased ?? 0}
            unit="envíos"
          />
          <BalanceCard
            icon={<Check className="w-4 h-4" />}
            label="Consumidos (total)"
            value={balance?.creditsConsumed ?? 0}
            unit="envíos"
          />
          <BalanceCard
            icon={<Gift className="w-4 h-4" />}
            label="Ganados por referidos"
            value={balance?.referralCreditsEarned ?? 0}
            unit="envíos"
          />
        </div>
      </div>

      {/* Packs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {packs.map((pack) => {
          const isPopular = pack.id === 'pack_100';
          const isBest = pack.id === 'pack_1000';
          const isLoading = loading === pack.id;
          return (
            <div
              key={pack.id}
              className={`bg-zinc-900/50 border rounded-xl p-6 relative ${
                isBest
                  ? 'border-amber-500/30'
                  : isPopular
                    ? 'border-cyan-500/30'
                    : 'border-white/[0.06]'
              }`}
            >
              {isPopular && !isBest && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-cyan-600 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase">
                  Más popular
                </div>
              )}
              {isBest && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-amber-500 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase">
                  Mejor precio
                </div>
              )}
              <div className="text-center mb-4">
                <h3 className="text-lg font-bold text-white">{pack.label}</h3>
                <div className="mt-3">
                  <p className="text-3xl font-bold text-white">
                    ${pack.totalPriceUyu.toLocaleString('es-UY')}
                    <span className="text-sm font-normal text-zinc-500"> UYU</span>
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    ${pack.pricePerShipmentUyu} UYU por envío
                  </p>
                </div>
              </div>
              <button
                onClick={() => handleBuy(pack.id)}
                disabled={isLoading}
                className={`block w-full text-center py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                  isBest
                    ? 'bg-amber-500 hover:bg-amber-400 text-zinc-950'
                    : isPopular
                      ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-white/[0.08]'
                }`}
              >
                {isLoading ? 'Redirigiendo...' : 'Comprar'}
              </button>
            </div>
          );
        })}
      </div>

      {/* Historial */}
      {recentPurchases.length > 0 && (
        <div className="bg-zinc-900/30 border border-white/[0.04] rounded-xl p-6 mb-8">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-4">
            Historial reciente
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs uppercase tracking-wide">
                  <th className="text-left pb-3 font-medium">Fecha</th>
                  <th className="text-left pb-3 font-medium">Pack</th>
                  <th className="text-right pb-3 font-medium">Envíos</th>
                  <th className="text-right pb-3 font-medium">Total</th>
                  <th className="text-right pb-3 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {recentPurchases.map((p) => (
                  <tr key={p.id} className="border-t border-white/[0.04]">
                    <td className="py-2.5">
                      {new Date(p.paidAt ?? p.createdAt).toLocaleDateString('es-UY', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-2.5">{p.packId}</td>
                    <td className="py-2.5 text-right tabular-nums">{p.shipments}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      ${p.totalPriceUyu.toLocaleString('es-UY')} UYU
                    </td>
                    <td className="py-2.5 text-right">
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
      <div className="bg-zinc-900/30 border border-white/[0.04] rounded-xl p-4 text-center">
        <p className="text-xs text-zinc-600">
          Pagos procesados por MercadoPago en pesos uruguayos (UYU).
          <br />
          Los envíos no caducan. Pagás una sola vez por pack, sin suscripción.
        </p>
      </div>
    </div>
  );
}

function BalanceCard({
  icon,
  label,
  value,
  unit,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  unit: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-zinc-500 text-xs uppercase tracking-wide mb-2">
        {icon}
        {label}
      </div>
      <p
        className={`text-3xl font-bold tabular-nums ${
          highlight ? 'text-emerald-400' : 'text-white'
        }`}
      >
        {value.toLocaleString('es-UY')}
      </p>
      <p className="text-xs text-zinc-500 mt-0.5">{unit}</p>
    </div>
  );
}

function PurchaseStatus({ status }: { status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' }) {
  const map = {
    PAID: { label: 'Pagado', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    PENDING: { label: 'Pendiente', cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    FAILED: { label: 'Rechazado', cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
    REFUNDED: { label: 'Reembolsado', cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20' },
  };
  const m = map[status];
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium border ${m.cls}`}>
      {m.label}
    </span>
  );
}
