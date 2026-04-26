'use client';

import { useEffect, useState } from 'react';
import { Copy, Check, Gift, Users, Sparkles } from 'lucide-react';

interface ReferralState {
  referralCode: string | null;
  referralLink: string | null;
  referralCreditsEarned: number;
  referralsCount: number;
  referrals: Array<{
    id: string;
    name: string;
    createdAt: string;
    creditsPurchased: number;
  }>;
  accruals: Array<{
    id: string;
    shipmentsAccrued: number;
    createdAt: string;
    referee: { id: string; name: string };
  }>;
}

export default function ReferralsPage() {
  const [state, setState] = useState<ReferralState | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/referrals/me')
      .then((r) => r.json())
      .then(({ data }) => setState(data))
      .catch(() => {});
  }, []);

  function copyLink() {
    if (!state?.referralLink) return;
    navigator.clipboard.writeText(state.referralLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Referidos</h1>
        <p className="text-zinc-500 text-sm mt-1">
          Compartí tu link y ganá el 20% de los envíos que compre cada referido.
        </p>
      </div>

      {/* How it works */}
      <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-6 mb-6">
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-cyan-400 flex-shrink-0 mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-cyan-300 mb-2">
              ¿Cómo funciona?
            </h2>
            <ol className="text-sm text-zinc-300 space-y-1 list-decimal list-inside">
              <li>Compartí tu link de referido con otros emprendedores.</li>
              <li>Cada uno recibe 10 envíos gratis al crear su cuenta.</li>
              <li>
                Cuando un referido compra un pack, vos recibís{' '}
                <strong className="text-cyan-300">20% de esos envíos</strong> gratis en tu saldo.
              </li>
            </ol>
          </div>
        </div>
      </div>

      {/* Link */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6 mb-6">
        <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Tu link de referido</p>
        {state?.referralLink ? (
          <div className="flex items-center gap-3">
            <input
              readOnly
              value={state.referralLink}
              className="flex-1 px-3.5 py-2.5 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-white text-sm font-mono"
              onFocus={(e) => e.target.select()}
            />
            <button
              onClick={copyLink}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                copied
                  ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-400'
                  : 'bg-cyan-600 hover:bg-cyan-500 text-white'
              }`}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
        ) : (
          <div className="text-zinc-500 text-sm">Cargando...</div>
        )}
        {state?.referralCode && (
          <p className="text-xs text-zinc-500 mt-2">
            Código: <span className="font-mono text-zinc-300">{state.referralCode}</span>
          </p>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
          <div className="flex items-center gap-2 text-zinc-500 text-xs uppercase tracking-wide mb-2">
            <Users className="w-4 h-4" />
            Referidos
          </div>
          <p className="text-3xl font-bold text-white tabular-nums">
            {state?.referralsCount ?? 0}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">cuentas creadas con tu link</p>
        </div>
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
          <div className="flex items-center gap-2 text-zinc-500 text-xs uppercase tracking-wide mb-2">
            <Gift className="w-4 h-4" />
            Envíos ganados
          </div>
          <p className="text-3xl font-bold text-emerald-400 tabular-nums">
            {state?.referralCreditsEarned ?? 0}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">acreditados a tu saldo</p>
        </div>
      </div>

      {/* Acreditaciones */}
      {state?.accruals && state.accruals.length > 0 && (
        <div className="bg-zinc-900/30 border border-white/[0.04] rounded-xl p-6 mb-6">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-4">
            Últimas acreditaciones
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs uppercase tracking-wide">
                  <th className="text-left pb-3 font-medium">Fecha</th>
                  <th className="text-left pb-3 font-medium">Referido</th>
                  <th className="text-right pb-3 font-medium">Envíos ganados</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {state.accruals.map((a) => (
                  <tr key={a.id} className="border-t border-white/[0.04]">
                    <td className="py-2.5">
                      {new Date(a.createdAt).toLocaleDateString('es-UY', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-2.5">{a.referee.name}</td>
                    <td className="py-2.5 text-right tabular-nums text-emerald-400">
                      +{a.shipmentsAccrued}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Referidos */}
      {state?.referrals && state.referrals.length > 0 && (
        <div className="bg-zinc-900/30 border border-white/[0.04] rounded-xl p-6">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-4">
            Tus referidos ({state.referrals.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs uppercase tracking-wide">
                  <th className="text-left pb-3 font-medium">Cuenta</th>
                  <th className="text-left pb-3 font-medium">Creada</th>
                  <th className="text-right pb-3 font-medium">Envíos comprados</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {state.referrals.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.04]">
                    <td className="py-2.5">{r.name}</td>
                    <td className="py-2.5">
                      {new Date(r.createdAt).toLocaleDateString('es-UY', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{r.creditsPurchased}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
