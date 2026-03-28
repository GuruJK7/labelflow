'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { CreditCard, Check, Zap, Crown, AlertCircle, Clock, XCircle } from 'lucide-react';

const plans = [
  {
    id: 'starter',
    name: 'Starter',
    priceUSD: 15,
    priceUYU: 600,
    limit: 100,
    icon: <Zap className="w-5 h-5" />,
    features: [
      '100 etiquetas/mes',
      'Procesamiento automatico',
      'Email al cliente',
      'Soporte email',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    priceUSD: 35,
    priceUYU: 1400,
    limit: 500,
    popular: true,
    icon: <Zap className="w-5 h-5" />,
    features: [
      '500 etiquetas/mes',
      'Procesamiento automatico',
      'Email al cliente',
      'Webhooks Shopify',
      'API + MCP access',
      'Soporte prioritario',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceUSD: 69,
    priceUYU: 2760,
    limit: 999999,
    icon: <Crown className="w-5 h-5" />,
    features: [
      'Etiquetas ilimitadas',
      'Todo de Growth',
      'Soporte dedicado',
      'Custom rules',
    ],
  },
];

type Settings = {
  subscriptionStatus: string;
  labelsThisMonth: number;
  stripePriceId?: string;
  stripeSubscriptionId?: string;
  currentPeriodEnd?: string;
};

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="text-zinc-500 text-sm p-8">Cargando...</div>}>
      <BillingContent />
    </Suspense>
  );
}

function BillingContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);

  const success = searchParams.get('success') === 'true';
  const error = searchParams.get('error') === 'true';
  const pending = searchParams.get('pending') === 'true';

  useEffect(() => {
    fetch('/api/v1/settings')
      .then((r) => r.json())
      .then(({ data }) => setSettings(data))
      .catch(() => {});
  }, []);

  const isActive = settings?.subscriptionStatus === 'ACTIVE';
  const isMpSubscription = settings?.stripeSubscriptionId?.startsWith('mp_sub_');

  const currentPlanId = settings?.stripePriceId;
  const periodEnd = settings?.currentPeriodEnd
    ? new Date(settings.currentPeriodEnd)
    : null;
  const periodEndStr = periodEnd
    ? periodEnd.toLocaleDateString('es-UY', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  function handleSubscribe(planId: string) {
    setLoading(planId);
    window.location.href = `/api/mercadopago/checkout?plan=${planId}`;
  }

  async function handleCancel() {
    if (!cancelConfirm) {
      setCancelConfirm(true);
      return;
    }

    setCancelling(true);
    try {
      const res = await fetch('/api/mercadopago/cancel', { method: 'POST' });
      const data = await res.json();

      if (res.ok && data.success) {
        setSettings((prev) =>
          prev
            ? {
                ...prev,
                subscriptionStatus: 'CANCELED',
                stripeSubscriptionId: undefined,
              }
            : prev
        );
        setCancelConfirm(false);
        router.refresh();
      } else {
        alert(data.error ?? 'Error al cancelar la suscripcion');
      }
    } catch {
      alert('Error de red al cancelar la suscripcion');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Billing</h1>
        <p className="text-zinc-500 text-sm mt-1">Gestiona tu suscripcion</p>
      </div>

      {/* Success / Error / Pending banners */}
      {success && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 mb-6 flex items-center gap-3">
          <Check className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-emerald-400">
              Suscripcion activada
            </p>
            <p className="text-xs text-emerald-400/70 mt-0.5">
              Tu suscripcion se activo correctamente. El cobro se renovara
              automaticamente cada mes.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-400">
              Error en el pago
            </p>
            <p className="text-xs text-red-400/70 mt-0.5">
              No se pudo procesar la suscripcion. Intenta nuevamente o usa otro
              medio de pago.
            </p>
          </div>
        </div>
      )}

      {pending && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 mb-6 flex items-center gap-3">
          <Clock className="w-5 h-5 text-yellow-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-yellow-400">
              Suscripcion pendiente
            </p>
            <p className="text-xs text-yellow-400/70 mt-0.5">
              Tu suscripcion esta siendo procesada. Te notificaremos cuando se
              confirme.
            </p>
          </div>
        </div>
      )}

      {/* Current status */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6 mb-8">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-zinc-400">Estado actual</p>
            <p className="text-lg font-bold text-white mt-1">
              {isActive ? (
                <span className="text-emerald-400">Activo</span>
              ) : settings?.subscriptionStatus === 'CANCELED' ? (
                <span className="text-red-400">Cancelado</span>
              ) : settings?.subscriptionStatus === 'PAST_DUE' ? (
                <span className="text-yellow-400">Pago pendiente</span>
              ) : (
                <span className="text-zinc-500">Inactivo</span>
              )}
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              {settings?.labelsThisMonth ?? 0} etiquetas este mes
            </p>
            {isActive && periodEndStr && (
              <p className="text-xs text-zinc-500 mt-0.5">
                Proxima renovacion: {periodEndStr}
              </p>
            )}
          </div>
          {isActive && currentPlanId && (
            <div className="flex items-center gap-2 bg-zinc-800 border border-white/[0.08] text-zinc-300 px-4 py-2 rounded-lg text-xs font-medium">
              <CreditCard className="w-3.5 h-3.5" />
              Plan{' '}
              {plans.find((p) => p.id === currentPlanId)?.name ?? currentPlanId}
            </div>
          )}
        </div>

        {/* Cancel subscription */}
        {isActive && isMpSubscription && (
          <div className="mt-4 pt-4 border-t border-white/[0.06]">
            {!cancelConfirm ? (
              <button
                onClick={handleCancel}
                className="flex items-center gap-2 text-xs text-zinc-500 hover:text-red-400 transition-colors"
              >
                <XCircle className="w-3.5 h-3.5" />
                Cancelar suscripcion
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <p className="text-xs text-red-400">
                  Se cancelara tu suscripcion y perderas acceso al finalizar el
                  periodo actual.
                </p>
                <button
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {cancelling ? 'Cancelando...' : 'Confirmar'}
                </button>
                <button
                  onClick={() => setCancelConfirm(false)}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
                >
                  Volver
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Plans */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plans.map((plan) => {
          const isCurrent = isActive && currentPlanId === plan.id;

          return (
            <div
              key={plan.id}
              className={`bg-zinc-900/50 border rounded-xl p-6 relative ${
                plan.popular
                  ? 'border-cyan-500/30'
                  : isCurrent
                    ? 'border-emerald-500/30'
                    : 'border-white/[0.06]'
              }`}
            >
              {plan.popular && !isCurrent && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-cyan-600 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase">
                  Mas popular
                </div>
              )}
              {isCurrent && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase">
                  Plan actual
                </div>
              )}

              <div className="text-center mb-6">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center mx-auto mb-3 ${
                    plan.popular
                      ? 'bg-cyan-600/20 text-cyan-400'
                      : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  {plan.icon}
                </div>
                <h3 className="text-lg font-bold text-white">{plan.name}</h3>
                <div className="mt-2">
                  <p className="text-3xl font-bold text-white">
                    ${plan.priceUYU}
                    <span className="text-sm font-normal text-zinc-500">
                      {' '}
                      UYU/mes
                    </span>
                  </p>
                  <p className="text-xs text-zinc-600 mt-0.5">
                    ~${plan.priceUSD} USD/mes
                  </p>
                </div>
              </div>

              <ul className="space-y-2 mb-6">
                {plan.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2 text-sm text-zinc-400"
                  >
                    <Check className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => handleSubscribe(plan.id)}
                disabled={isCurrent || loading === plan.id}
                className={`block w-full text-center py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  plan.popular
                    ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
                    : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-white/[0.08]'
                }`}
              >
                {loading === plan.id
                  ? 'Redirigiendo...'
                  : isCurrent
                    ? 'Plan actual'
                    : isActive
                      ? 'Cambiar plan'
                      : 'Suscribirse'}
              </button>
            </div>
          );
        })}
      </div>

      {/* Payment info */}
      <div className="mt-8 bg-zinc-900/30 border border-white/[0.04] rounded-xl p-4">
        <p className="text-xs text-zinc-600 text-center">
          Pagos procesados por MercadoPago. Precios en pesos uruguayos (UYU).
          <br />
          Al suscribirte seras redirigido a MercadoPago para autorizar el cobro
          automatico mensual.
        </p>
      </div>
    </div>
  );
}
