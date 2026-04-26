'use client';

import { useEffect, useState } from 'react';
import {
  Copy,
  Check,
  Gift,
  Users,
  Sparkles,
  Share2,
  TrendingUp,
  Send,
  ShoppingCart,
  Plus,
} from 'lucide-react';

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

  function shareWhatsApp() {
    if (!state?.referralLink) return;
    const msg = encodeURIComponent(
      `Te recomiendo LabelFlow para automatizar tus envíos con DAC. Te regalan 10 envíos gratis si te registrás con mi link: ${state.referralLink}`,
    );
    window.open(`https://wa.me/?text=${msg}`, '_blank');
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-10">
        <div className="flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-widest mb-3">
          <Gift className="w-3.5 h-3.5" />
          Programa de referidos
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-white tracking-tight">
          Compartí y <span className="bg-gradient-to-r from-cyan-300 to-emerald-300 bg-clip-text text-transparent">ganá envíos gratis</span>
        </h1>
        <p className="text-zinc-400 text-sm mt-2 max-w-2xl">
          Invitá a otros emprendedores. Cada referido recibe 10 envíos al registrarse y vos te
          quedás con el 20% de lo que compren — para siempre.
        </p>
      </div>

      {/* Hero link card */}
      <div className="relative overflow-hidden rounded-3xl mb-8 group">
        <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/20 via-emerald-500/10 to-transparent" />
        <div className="absolute -top-32 -left-32 w-80 h-80 bg-cyan-500/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-32 -right-32 w-80 h-80 bg-emerald-500/20 rounded-full blur-3xl" />
        <div className="absolute inset-0 bg-zinc-900/50 backdrop-blur-xl" />
        <div className="relative border border-cyan-500/20 rounded-3xl p-6 md:p-8">
          <div className="flex items-center gap-2 text-cyan-300/80 text-xs font-medium uppercase tracking-widest mb-4">
            <Share2 className="w-3.5 h-3.5" />
            Tu link de referido
          </div>

          {state?.referralLink ? (
            <>
              <div className="flex flex-col sm:flex-row items-stretch gap-2.5">
                <div className="flex-1 relative group/input">
                  <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/30 to-emerald-500/30 rounded-xl opacity-50 group-hover/input:opacity-80 transition-opacity blur-sm" />
                  <input
                    readOnly
                    value={state.referralLink}
                    className="relative w-full px-4 py-3 bg-zinc-950/80 border border-white/[0.08] rounded-xl text-white text-sm font-mono backdrop-blur-sm focus:outline-none focus:border-cyan-500/40"
                    onFocus={(e) => e.target.select()}
                  />
                </div>
                <button
                  onClick={copyLink}
                  className={`relative flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold transition-all ${
                    copied
                      ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                      : 'bg-cyan-500 hover:bg-cyan-400 text-zinc-950 shadow-lg shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:-translate-y-0.5'
                  }`}
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4" />
                      Copiado
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copiar link
                    </>
                  )}
                </button>
                <button
                  onClick={shareWhatsApp}
                  className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 text-emerald-300 transition-all hover:-translate-y-0.5"
                >
                  <Send className="w-4 h-4" />
                  WhatsApp
                </button>
              </div>

              {state.referralCode && (
                <div className="mt-4 flex items-center gap-3 text-xs">
                  <span className="text-zinc-500">Tu código:</span>
                  <span className="font-mono text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 px-2.5 py-1 rounded-md">
                    {state.referralCode}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="text-zinc-500 text-sm py-4">Cargando tu link...</div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-10">
        {/* Referidos card */}
        <div className="relative overflow-hidden rounded-2xl group">
          <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 to-transparent" />
          <div className="absolute inset-0 bg-zinc-900/50 backdrop-blur-sm" />
          <div className="relative border border-white/[0.06] hover:border-cyan-500/20 rounded-2xl p-6 transition-colors">
            <div className="flex items-start justify-between mb-5">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 border border-cyan-500/20 flex items-center justify-center">
                <Users className="w-5 h-5 text-cyan-400" />
              </div>
              <span className="text-[10px] font-semibold text-cyan-400/70 uppercase tracking-wider">
                Total
              </span>
            </div>
            <p className="text-5xl font-bold tabular-nums bg-gradient-to-br from-white to-cyan-200 bg-clip-text text-transparent">
              {state?.referralsCount ?? 0}
            </p>
            <p className="text-sm text-zinc-400 mt-2">
              {(state?.referralsCount ?? 0) === 1 ? 'cuenta creada' : 'cuentas creadas'} con tu link
            </p>
          </div>
        </div>

        {/* Envíos ganados card */}
        <div className="relative overflow-hidden rounded-2xl group">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 to-transparent" />
          <div className="absolute inset-0 bg-zinc-900/50 backdrop-blur-sm" />
          <div className="relative border border-white/[0.06] hover:border-emerald-500/20 rounded-2xl p-6 transition-colors">
            <div className="flex items-start justify-between mb-5">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 border border-emerald-500/20 flex items-center justify-center">
                <Gift className="w-5 h-5 text-emerald-400" />
              </div>
              <div className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400/70 uppercase tracking-wider">
                <TrendingUp className="w-3 h-3" />
                Acreditados
              </div>
            </div>
            <p className="text-5xl font-bold tabular-nums bg-gradient-to-br from-white to-emerald-200 bg-clip-text text-transparent">
              {state?.referralCreditsEarned ?? 0}
            </p>
            <p className="text-sm text-zinc-400 mt-2">envíos gratis a tu saldo</p>
          </div>
        </div>
      </div>

      {/* How it works — 3 steps */}
      <div className="mb-10">
        <h2 className="text-xl font-bold text-white mb-1">Cómo funciona</h2>
        <p className="text-zinc-500 text-sm mb-5">3 pasos para empezar a ganar envíos</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Step
            number={1}
            icon={<Send className="w-5 h-5" />}
            title="Compartí tu link"
            description="Mandale tu link único a otros emprendedores que vendan en Shopify."
            accent="cyan"
          />
          <Step
            number={2}
            icon={<ShoppingCart className="w-5 h-5" />}
            title="Tu referido compra"
            description="Cada uno arranca con 10 envíos gratis y compra packs cuando los necesite."
            accent="cyan"
          />
          <Step
            number={3}
            icon={<Plus className="w-5 h-5" />}
            title="Vos ganás 20%"
            description="Por cada pack que compre tu referido, recibís el 20% en envíos gratis."
            accent="emerald"
          />
        </div>
      </div>

      {/* Acreditaciones */}
      {state?.accruals && state.accruals.length > 0 && (
        <div className="bg-zinc-900/40 border border-white/[0.06] rounded-2xl p-6 mb-6 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-emerald-400" />
              </div>
              <h2 className="text-base font-semibold text-white">Últimas acreditaciones</h2>
            </div>
          </div>
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                  <th className="text-left pb-3 px-2 font-medium">Fecha</th>
                  <th className="text-left pb-3 px-2 font-medium">Referido</th>
                  <th className="text-right pb-3 px-2 font-medium">Envíos ganados</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {state.accruals.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="py-3 px-2 text-zinc-400">
                      {new Date(a.createdAt).toLocaleDateString('es-UY', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-3 px-2">{a.referee.name}</td>
                    <td className="py-3 px-2 text-right tabular-nums font-semibold text-emerald-400">
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
        <div className="bg-zinc-900/40 border border-white/[0.06] rounded-2xl p-6 mb-6 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                <Users className="w-4 h-4 text-cyan-400" />
              </div>
              <h2 className="text-base font-semibold text-white">
                Tus referidos
              </h2>
            </div>
            <span className="text-xs text-zinc-500">
              {state.referrals.length} cuenta{state.referrals.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                  <th className="text-left pb-3 px-2 font-medium">Cuenta</th>
                  <th className="text-left pb-3 px-2 font-medium">Creada</th>
                  <th className="text-right pb-3 px-2 font-medium">Envíos comprados</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {state.referrals.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="py-3 px-2 font-medium">{r.name}</td>
                    <td className="py-3 px-2 text-zinc-400">
                      {new Date(r.createdAt).toLocaleDateString('es-UY', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-3 px-2 text-right tabular-nums">
                      {r.creditsPurchased}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {(!state?.referrals || state.referrals.length === 0) && (
        <div className="bg-zinc-900/30 border border-dashed border-white/[0.08] rounded-2xl p-10 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 mb-4">
            <Users className="w-6 h-6 text-cyan-400" />
          </div>
          <h3 className="text-base font-semibold text-white mb-1">
            Todavía no tenés referidos
          </h3>
          <p className="text-sm text-zinc-500 max-w-md mx-auto">
            Compartí tu link y empezá a ganar envíos. Cada cuenta que se cree con tu link te genera 20% de lo que compre.
          </p>
        </div>
      )}
    </div>
  );
}

function Step({
  number,
  icon,
  title,
  description,
  accent,
}: {
  number: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  accent: 'cyan' | 'emerald';
}) {
  const accentMap = {
    cyan: {
      icon: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
      number: 'text-cyan-300',
      hoverBorder: 'hover:border-cyan-500/20',
    },
    emerald: {
      icon: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
      number: 'text-emerald-300',
      hoverBorder: 'hover:border-emerald-500/20',
    },
  };
  const a = accentMap[accent];
  return (
    <div
      className={`bg-zinc-900/40 border border-white/[0.06] ${a.hoverBorder} rounded-2xl p-5 backdrop-blur-sm transition-colors`}
    >
      <div className="flex items-start justify-between mb-4">
        <div
          className={`w-11 h-11 rounded-xl border flex items-center justify-center ${a.icon}`}
        >
          {icon}
        </div>
        <span className={`text-3xl font-bold ${a.number} opacity-30`}>0{number}</span>
      </div>
      <h3 className="text-sm font-semibold text-white mb-1">{title}</h3>
      <p className="text-xs text-zinc-400 leading-relaxed">{description}</p>
    </div>
  );
}
