'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Zap,
  ShoppingBag,
  Truck,
  CreditCard,
  ArrowRight,
  ArrowLeft,
  Check,
  Loader2,
  ExternalLink,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';
import { cn } from '@/lib/cn';

type Step = 1 | 2 | 3;

interface StepConfig {
  number: number;
  title: string;
  description: string;
  icon: typeof ShoppingBag;
}

const STEPS: StepConfig[] = [
  { number: 1, title: 'Shopify', description: 'Conecta tu tienda', icon: ShoppingBag },
  { number: 2, title: 'DAC Uruguay', description: 'Credenciales de envio', icon: Truck },
  { number: 3, title: 'Cargá envíos', description: 'Elegí un pack', icon: CreditCard },
];

// Mirror lib/credit-packs.ts — paquetes de envíos en UYU. La fuente de
// verdad sigue siendo el server (lib/credit-packs.ts), aquí solo está la
// info necesaria para renderizar el step 3.
type OnboardingPack = {
  id: string;
  shipments: number;
  pricePerShipmentUyu: number;
  totalPriceUyu: number;
  tagline: string;
  popular?: boolean;
  best?: boolean;
};

const ONBOARDING_PACKS: OnboardingPack[] = [
  { id: 'pack_10',   shipments: 10,   pricePerShipmentUyu: 20, totalPriceUyu: 200,  tagline: 'Para probar' },
  { id: 'pack_100',  shipments: 100,  pricePerShipmentUyu: 15, totalPriceUyu: 1500, tagline: 'El favorito',         popular: true },
  { id: 'pack_1000', shipments: 1000, pricePerShipmentUyu: 7,  totalPriceUyu: 7000, tagline: 'Mejor precio/envío',  best: true },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Step 1: Shopify
  const [shopifyUrl, setShopifyUrl] = useState('');
  const [shopifyToken, setShopifyToken] = useState('');
  const [shopifyVerified, setShopifyVerified] = useState(false);

  // Step 2: DAC
  const [dacUsername, setDacUsername] = useState('');
  const [dacPassword, setDacPassword] = useState('');
  const [dacSaved, setDacSaved] = useState(false);

  const inputClass =
    'w-full px-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all';
  const labelClass = 'block text-xs font-medium text-zinc-400 mb-1.5';

  async function saveSettings(body: Record<string, unknown>) {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/v1/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Error al guardar');
        return false;
      }
      return true;
    } catch {
      setError('Error de conexion');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleShopifySave(e: FormEvent) {
    e.preventDefault();
    if (!shopifyUrl || !shopifyToken) {
      setError('Completa URL y token de Shopify');
      return;
    }
    const ok = await saveSettings({ shopifyStoreUrl: shopifyUrl, shopifyToken });
    if (ok) {
      setShopifyVerified(true);
      setSuccess('Shopify conectado correctamente');
    }
  }

  async function handleDacSave(e: FormEvent) {
    e.preventDefault();
    if (!dacUsername || !dacPassword) {
      setError('Completa usuario y password de DAC');
      return;
    }
    const ok = await saveSettings({ dacUsername, dacPassword });
    if (ok) {
      setDacSaved(true);
      setSuccess('Credenciales DAC guardadas');
    }
  }

  async function handleSelectPack(packId: string) {
    setSaving(true);
    setError('');
    try {
      // /api/credit-packs/checkout devuelve un redirect 3xx hacia la URL
      // de pago de MercadoPago. Si llega como JSON con `url`, también lo
      // soportamos por compat.
      const res = await fetch(`/api/credit-packs/checkout?pack=${packId}`);
      if (res.redirected) {
        window.location.href = res.url;
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      setError(data?.error ?? 'Error al iniciar el pago');
    } catch {
      setError('Error al iniciar el pago');
    }
    setSaving(false);
  }

  function nextStep() {
    setError('');
    setSuccess('');
    if (step < 3) setStep((step + 1) as Step);
  }

  function prevStep() {
    setError('');
    setSuccess('');
    if (step > 1) setStep((step - 1) as Step);
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col">
      {/* Header */}
      <div className="border-b border-white/[0.04] px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-white text-sm">
              Label<span className="text-cyan-400">Flow</span>
            </span>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Saltar por ahora
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="max-w-2xl mx-auto w-full px-6 pt-8">
        <div className="flex items-center gap-4 mb-8">
          {STEPS.map((s, i) => {
            const isActive = s.number === step;
            const isCompleted = s.number < step || (s.number === 1 && shopifyVerified) || (s.number === 2 && dacSaved);
            const StepIcon = s.icon;
            return (
              <div key={s.number} className="flex items-center flex-1">
                <div className="flex items-center gap-3 flex-1">
                  <div
                    className={cn(
                      'w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 flex-shrink-0',
                      isCompleted
                        ? 'bg-emerald-500/20 border border-emerald-500/30'
                        : isActive
                          ? 'bg-cyan-500/20 border border-cyan-500/30'
                          : 'bg-white/[0.03] border border-white/[0.06]'
                    )}
                  >
                    {isCompleted ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <StepIcon className={cn('w-4 h-4', isActive ? 'text-cyan-400' : 'text-zinc-600')} />
                    )}
                  </div>
                  <div className="hidden sm:block">
                    <p className={cn('text-xs font-medium', isActive ? 'text-white' : 'text-zinc-500')}>
                      {s.title}
                    </p>
                    <p className="text-[10px] text-zinc-600">{s.description}</p>
                  </div>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={cn('h-px flex-1 mx-3', isCompleted ? 'bg-emerald-500/30' : 'bg-white/[0.06]')} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center px-6 pb-12">
        <div className="w-full max-w-2xl">
          {/* Messages */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm flex items-center gap-2">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              {success}
            </div>
          )}

          {/* STEP 1: Shopify */}
          {step === 1 && (
            <div className="glass rounded-2xl p-8 animate-fade-in">
              <h2 className="text-xl font-bold text-white mb-1">Conecta tu tienda Shopify</h2>
              <p className="text-zinc-500 text-sm mb-6">
                Necesitamos tu URL de tienda y un token de Admin API para leer pedidos.
              </p>

              <div className="bg-white/[0.02] rounded-xl p-4 mb-6 border border-white/[0.04]">
                <p className="text-xs font-medium text-zinc-400 mb-2">Como obtener el token:</p>
                <ol className="text-xs text-zinc-500 space-y-1.5 list-decimal list-inside">
                  <li>Entra a tu admin de Shopify</li>
                  <li>Configuracion &gt; Apps &gt; Desarrollar apps</li>
                  <li>Crear app &gt; Configurar permisos de Admin API</li>
                  <li>Habilitar: <code className="text-cyan-400/80">read_orders</code> y <code className="text-cyan-400/80">write_orders</code></li>
                  <li>Instalar app &gt; Copiar el token <code className="text-cyan-400/80">shpat_xxx</code></li>
                </ol>
              </div>

              <form onSubmit={handleShopifySave} className="space-y-4">
                <div>
                  <label className={labelClass}>Store URL</label>
                  <input
                    value={shopifyUrl}
                    onChange={(e) => setShopifyUrl(e.target.value)}
                    className={inputClass}
                    placeholder="mitienda.myshopify.com"
                    required
                  />
                </div>
                <div>
                  <label className={labelClass}>Access Token</label>
                  <input
                    type="password"
                    value={shopifyToken}
                    onChange={(e) => setShopifyToken(e.target.value)}
                    className={inputClass}
                    placeholder="shpat_xxxxxxxxxxxxxxxxx"
                    required
                  />
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white py-3 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {shopifyVerified ? 'Verificado' : 'Verificar y guardar'}
                  </button>
                  <button
                    type="button"
                    onClick={nextStep}
                    className="px-6 py-3 rounded-xl border border-white/[0.08] text-zinc-400 text-sm hover:bg-white/[0.03] transition-colors flex items-center gap-1"
                  >
                    Siguiente <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* STEP 2: DAC */}
          {step === 2 && (
            <div className="glass rounded-2xl p-8 animate-fade-in">
              <h2 className="text-xl font-bold text-white mb-1">Conecta tu cuenta DAC</h2>
              <p className="text-zinc-500 text-sm mb-6">
                Usa tu Documento/RUT y password de dac.com.uy para generar envios automaticamente.
              </p>

              <div className="bg-white/[0.02] rounded-xl p-4 mb-6 border border-white/[0.04]">
                <p className="text-xs text-zinc-500">
                  No tenes cuenta en DAC?{' '}
                  <a
                    href="https://www.dac.com.uy/usuarios/registro"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1"
                  >
                    Registrate aca <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              </div>

              <form onSubmit={handleDacSave} className="space-y-4">
                <div>
                  <label className={labelClass}>Documento / RUT</label>
                  <input
                    value={dacUsername}
                    onChange={(e) => setDacUsername(e.target.value)}
                    className={inputClass}
                    placeholder="12345678"
                    required
                  />
                  <p className="text-[10px] text-zinc-600 mt-1">El mismo que usas para loguearte en dac.com.uy</p>
                </div>
                <div>
                  <label className={labelClass}>Password</label>
                  <input
                    type="password"
                    value={dacPassword}
                    onChange={(e) => setDacPassword(e.target.value)}
                    className={inputClass}
                    placeholder="Tu password de DAC"
                    required
                  />
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={prevStep}
                    className="px-6 py-3 rounded-xl border border-white/[0.08] text-zinc-400 text-sm hover:bg-white/[0.03] transition-colors flex items-center gap-1"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" /> Anterior
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white py-3 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {dacSaved ? 'Guardado' : 'Guardar credenciales'}
                  </button>
                  <button
                    type="button"
                    onClick={nextStep}
                    className="px-6 py-3 rounded-xl border border-white/[0.08] text-zinc-400 text-sm hover:bg-white/[0.03] transition-colors flex items-center gap-1"
                  >
                    Siguiente <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* STEP 3: Cargá envíos (credit packs en UYU) */}
          {step === 3 && (
            <div className="animate-fade-in">
              <div className="text-center mb-8">
                <h2 className="text-xl font-bold text-white mb-1">Cargá envíos</h2>
                <p className="text-zinc-500 text-sm">
                  Pagás solo por lo que usás. <span className="text-emerald-400">Tenés 10 envíos gratis</span> para arrancar — sumá un pack cuando quieras.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                {ONBOARDING_PACKS.map((pack) => {
                  const highlighted = pack.popular || pack.best;
                  return (
                    <div
                      key={pack.id}
                      className={cn(
                        'glass rounded-2xl p-6 pt-7 relative transition-all duration-200',
                        pack.popular && 'ring-1 ring-cyan-500/40 bg-cyan-500/[0.03]',
                        pack.best && 'ring-1 ring-emerald-500/40 bg-emerald-500/[0.03]',
                      )}
                    >
                      {pack.popular && (
                        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] font-semibold text-cyan-400 bg-[#0a0a0a] border border-cyan-500/30 px-2.5 py-0.5 rounded-full uppercase tracking-wider whitespace-nowrap">
                          Más popular
                        </span>
                      )}
                      {pack.best && (
                        <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] font-semibold text-emerald-400 bg-[#0a0a0a] border border-emerald-500/30 px-2.5 py-0.5 rounded-full uppercase tracking-wider whitespace-nowrap">
                          Mejor precio
                        </span>
                      )}
                      <p className="text-[11px] text-zinc-500 mb-1">{pack.tagline}</p>
                      <h3 className="text-2xl font-bold text-white mb-1">{pack.shipments.toLocaleString('es-UY')} envíos</h3>
                      <p className="mb-4">
                        <span className="text-2xl font-bold text-white">${pack.totalPriceUyu.toLocaleString('es-UY')}</span>
                        <span className="text-xs text-zinc-500"> UYU</span>
                        <span className="block text-[11px] text-zinc-500 mt-0.5">
                          ${pack.pricePerShipmentUyu} UYU por envío
                        </span>
                      </p>
                      <ul className="space-y-2 mb-5">
                        <li className="flex items-center gap-2 text-xs text-zinc-400">
                          <Check className="w-3 h-3 text-cyan-400 flex-shrink-0" />
                          Sin vencimiento
                        </li>
                        <li className="flex items-center gap-2 text-xs text-zinc-400">
                          <Check className="w-3 h-3 text-cyan-400 flex-shrink-0" />
                          Pago único, no se renueva
                        </li>
                        <li className="flex items-center gap-2 text-xs text-zinc-400">
                          <Check className="w-3 h-3 text-cyan-400 flex-shrink-0" />
                          Acreditación inmediata
                        </li>
                      </ul>
                      <button
                        onClick={() => handleSelectPack(pack.id)}
                        disabled={saving}
                        className={cn(
                          'w-full py-2.5 rounded-xl text-xs font-medium transition-all disabled:opacity-50',
                          highlighted
                            ? pack.best
                              ? 'bg-gradient-to-r from-emerald-600 to-emerald-500 text-white hover:from-emerald-500 hover:to-emerald-400'
                              : 'bg-gradient-to-r from-cyan-600 to-cyan-500 text-white hover:from-cyan-500 hover:to-cyan-400'
                            : 'border border-white/[0.08] text-zinc-300 hover:bg-white/[0.03]',
                        )}
                      >
                        {saving ? 'Cargando…' : 'Comprar con MercadoPago'}
                      </button>
                    </div>
                  );
                })}
              </div>

              <p className="text-center text-[11px] text-zinc-600 mb-6">
                ¿Necesitás otro tamaño? En{' '}
                <button
                  type="button"
                  onClick={() => router.push('/settings/billing')}
                  className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                >
                  Facturación
                </button>{' '}
                tenés 6 packs (10, 50, 100, 250, 500, 1000 envíos).
              </p>

              <div className="flex justify-between">
                <button
                  onClick={prevStep}
                  className="px-6 py-3 rounded-xl border border-white/[0.08] text-zinc-400 text-sm hover:bg-white/[0.03] transition-colors flex items-center gap-1"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> Anterior
                </button>
                <button
                  onClick={() => router.push('/dashboard')}
                  className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  Saltar — uso los 10 envíos gratis
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
