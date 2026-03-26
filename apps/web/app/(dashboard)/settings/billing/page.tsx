'use client';

import { useEffect, useState } from 'react';
import { CreditCard, Check, Zap, Crown } from 'lucide-react';

const plans = [
  {
    id: 'starter',
    name: 'Starter',
    price: 15,
    limit: 100,
    icon: <Zap className="w-5 h-5" />,
    features: ['100 etiquetas/mes', 'Procesamiento automatico', 'Email al cliente', 'Soporte email'],
  },
  {
    id: 'growth',
    name: 'Growth',
    price: 35,
    limit: 500,
    popular: true,
    icon: <Zap className="w-5 h-5" />,
    features: ['500 etiquetas/mes', 'Procesamiento automatico', 'Email al cliente', 'Webhooks Shopify', 'API + MCP access', 'Soporte prioritario'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 69,
    limit: 999999,
    icon: <Crown className="w-5 h-5" />,
    features: ['Etiquetas ilimitadas', 'Todo de Growth', 'Soporte dedicado', 'Custom rules'],
  },
];

export default function BillingPage() {
  const [settings, setSettings] = useState<{ subscriptionStatus: string; labelsThisMonth: number; stripePriceId?: string } | null>(null);

  useEffect(() => {
    fetch('/api/v1/settings')
      .then((r) => r.json())
      .then(({ data }) => setSettings(data))
      .catch(() => {});
  }, []);

  const isActive = settings?.subscriptionStatus === 'ACTIVE';

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Billing</h1>
        <p className="text-zinc-500 text-sm mt-1">Gestion tu suscripcion</p>
      </div>

      {/* Current status */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6 mb-8">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-zinc-400">Estado actual</p>
            <p className="text-lg font-bold text-white mt-1">
              {isActive ? (
                <span className="text-emerald-400">Activo</span>
              ) : (
                <span className="text-zinc-500">Inactivo</span>
              )}
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              {settings?.labelsThisMonth ?? 0} etiquetas este mes
            </p>
          </div>
          {isActive && (
            <a href="/api/stripe/portal" className="inline-flex items-center gap-2 bg-zinc-800 border border-white/[0.08] text-zinc-300 px-4 py-2 rounded-lg text-xs font-medium hover:bg-zinc-700 transition-colors">
              <CreditCard className="w-3.5 h-3.5" />
              Gestionar suscripcion
            </a>
          )}
        </div>
      </div>

      {/* Plans */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plans.map((plan) => (
          <div
            key={plan.id}
            className={`bg-zinc-900/50 border rounded-xl p-6 relative ${
              plan.popular ? 'border-cyan-500/30' : 'border-white/[0.06]'
            }`}
          >
            {plan.popular && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-cyan-600 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase">
                Mas popular
              </div>
            )}

            <div className="text-center mb-6">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center mx-auto mb-3 ${plan.popular ? 'bg-cyan-600/20 text-cyan-400' : 'bg-zinc-800 text-zinc-400'}`}>
                {plan.icon}
              </div>
              <h3 className="text-lg font-bold text-white">{plan.name}</h3>
              <p className="text-3xl font-bold text-white mt-2">
                ${plan.price}
                <span className="text-sm font-normal text-zinc-500">/mes</span>
              </p>
            </div>

            <ul className="space-y-2 mb-6">
              {plan.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm text-zinc-400">
                  <Check className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                  {f}
                </li>
              ))}
            </ul>

            <a
              href={`/api/stripe/checkout?plan=${plan.id}`}
              className={`block text-center py-2.5 rounded-lg text-sm font-medium transition-colors ${
                plan.popular
                  ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-white/[0.08]'
              }`}
            >
              {isActive ? 'Cambiar plan' : 'Empezar'}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
