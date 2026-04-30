'use client';

import Link from 'next/link';
import { TrackedSignupLink } from '@/components/TrackedSignupLink';
import {
  Zap,
  Package,
  Mail,
  Check,
  ArrowRight,
  Sparkles,
  Gift,
  Send,
  ShoppingCart,
  Plus,
  TrendingDown,
  ShieldCheck,
  Clock,
  MessageSquare,
  Wallet,
  Truck,
  BadgeCheck,
} from 'lucide-react';

// Credit-pack catalog. Mirrors lib/credit-packs.ts so the landing stays in sync
// with what the dashboard sells. If business changes pack pricing, update both.
const PACKS = [
  {
    id: 'pack_10',
    shipments: 10,
    pricePerShipmentUyu: 20,
    totalPriceUyu: 200,
    tagline: 'Ideal para empezar a probar',
  },
  {
    id: 'pack_50',
    shipments: 50,
    pricePerShipmentUyu: 17,
    totalPriceUyu: 850,
    tagline: 'Para tiendas que arrancan',
  },
  {
    id: 'pack_100',
    shipments: 100,
    pricePerShipmentUyu: 15,
    totalPriceUyu: 1500,
    tagline: 'El favorito de los emprendedores',
    popular: true,
  },
  {
    id: 'pack_250',
    shipments: 250,
    pricePerShipmentUyu: 12,
    totalPriceUyu: 3000,
    tagline: 'Para negocios en crecimiento',
  },
  {
    id: 'pack_500',
    shipments: 500,
    pricePerShipmentUyu: 10,
    totalPriceUyu: 5000,
    tagline: 'Para tiendas con alta demanda',
  },
  {
    id: 'pack_1000',
    shipments: 1000,
    pricePerShipmentUyu: 7,
    totalPriceUyu: 7000,
    tagline: 'Para operaciones establecidas',
    best: true,
  },
] as const;

// pack_10 baseline — used as anchor for "Antes $X" strikethrough.
const REF_PRICE = 20;

export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-[#0a0a0a] overflow-x-hidden">
      {/* Decorative ambient orbs */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-40 left-1/3 w-[600px] h-[600px] bg-cyan-500/[0.08] rounded-full blur-[120px]" />
        <div className="absolute top-[40%] -right-32 w-[500px] h-[500px] bg-emerald-500/[0.05] rounded-full blur-[120px]" />
      </div>

      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-[#0a0a0a]/70 backdrop-blur-xl border-b border-white/[0.04]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-white text-[15px] tracking-tight">
              Label<span className="text-cyan-400">Flow</span>
            </span>
          </Link>
          <div className="hidden md:flex items-center gap-8 text-[13px] text-zinc-400">
            <a href="#como-funciona" className="hover:text-white transition-colors">
              Cómo funciona
            </a>
            <a href="#precios" className="hover:text-white transition-colors">
              Precios
            </a>
            <a href="#referidos" className="hover:text-white transition-colors">
              Referidos
            </a>
            <a href="#faq" className="hover:text-white transition-colors">
              FAQ
            </a>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="hidden sm:inline text-zinc-400 hover:text-white text-[13px] transition-colors"
            >
              Iniciar sesión
            </Link>
            <TrackedSignupLink
              href="/signup"
              ctaLocation="navbar"
              className="bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 hover:-translate-y-0.5"
            >
              Crear cuenta
            </TrackedSignupLink>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-36 pb-16 px-6">
        <div className="max-w-5xl mx-auto text-center">
          {/* Animated reward badge — anchor the gift in real money */}
          <div className="inline-flex items-center gap-2 bg-gradient-to-r from-cyan-500/15 to-emerald-500/15 border border-cyan-400/30 rounded-full pl-2 pr-4 py-1.5 mb-8 backdrop-blur-sm shadow-lg shadow-cyan-500/10 animate-pulse-slow">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gradient-to-br from-cyan-400 to-emerald-400">
              <Sparkles className="w-3 h-3 text-zinc-950" strokeWidth={3} />
            </span>
            <span className="text-cyan-100 text-xs font-semibold tracking-wide">
              <span className="text-emerald-300">10 envíos GRATIS</span> al
              registrarte ·{' '}
              <span className="text-zinc-400 line-through">$200 UYU</span>{' '}
              <span className="text-emerald-300 font-bold">$0</span>
            </span>
          </div>
          <h1 className="text-5xl md:text-7xl font-bold text-white leading-[1.05] tracking-tight mb-6">
            Etiquetas de DAC
            <br />
            <span className="bg-gradient-to-r from-cyan-300 via-cyan-400 to-emerald-300 bg-clip-text text-transparent">
              automáticas
            </span>{' '}
            desde Shopify
          </h1>
          <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Conectá tu tienda y olvidate del trabajo manual. LabelFlow procesa los pedidos pagados,
            genera la guía DAC y le avisa al cliente — solo.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <TrackedSignupLink
              href="/signup"
              ctaLocation="hero"
              className="group inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-7 py-3.5 rounded-xl text-sm font-semibold transition-all shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:-translate-y-0.5"
            >
              Comenzá ya · 10 envíos gratis
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </TrackedSignupLink>
            <a
              href="#precios"
              className="inline-flex items-center gap-2 border border-white/10 text-zinc-200 px-6 py-3.5 rounded-xl text-sm font-semibold hover:bg-white/[0.04] hover:border-white/20 transition-colors"
            >
              Ver precios
            </a>
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            Registrate con Google en 1 click ·{' '}
            <TrackedSignupLink
              href="/signup"
              ctaLocation="hero_secondary"
              className="text-cyan-400 hover:text-cyan-300 transition-colors underline-offset-2 hover:underline"
            >
              empezar ahora →
            </TrackedSignupLink>
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mt-6 text-xs text-zinc-500">
            <div className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              Sin tarjeta para empezar
            </div>
            <div className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              Sin suscripción
            </div>
            <div className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              Sin caducidad
            </div>
          </div>
        </div>
      </section>

      {/* Trust strip / mini stats */}
      <section className="px-6 pb-20">
        <div className="max-w-5xl mx-auto">
          <div className="bg-zinc-900/40 border border-white/[0.06] rounded-2xl backdrop-blur-sm p-6 grid grid-cols-2 md:grid-cols-4 gap-6">
            {[
              { value: '< 60s', label: 'En conectarse' },
              { value: '24/7', label: 'Procesando solo' },
              { value: 'UYU', label: 'Pagás en pesos' },
              { value: '0', label: 'Suscripciones' },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-2xl md:text-3xl font-bold bg-gradient-to-br from-white to-cyan-200 bg-clip-text text-transparent tabular-nums">
                  {s.value}
                </p>
                <p className="text-xs text-zinc-500 mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="como-funciona" className="py-16 md:py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-widest mb-3">
              <Zap className="w-3.5 h-3.5" />
              Cómo funciona
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight">
              Conectá una vez. <span className="text-zinc-500">Olvidate para siempre.</span>
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              {
                num: '01',
                icon: <Truck className="w-6 h-6" />,
                title: 'Conectá tu tienda',
                desc: 'Vinculás tu Shopify y tu cuenta DAC en menos de 60 segundos. Sin código.',
              },
              {
                num: '02',
                icon: <ShoppingCart className="w-6 h-6" />,
                title: 'Tu cliente compra',
                desc: 'Cuando MercadoPago acredita el pago, LabelFlow detecta el pedido al instante.',
              },
              {
                num: '03',
                icon: <BadgeCheck className="w-6 h-6" />,
                title: 'Etiqueta lista, cliente avisado',
                desc: 'Generamos la guía DAC y le mandamos un email a tu cliente con el número de seguimiento.',
              },
            ].map((s) => (
              <div key={s.num} className="relative group">
                <div className="bg-zinc-900/40 border border-white/[0.06] hover:border-cyan-500/30 rounded-2xl p-6 backdrop-blur-sm transition-all hover:-translate-y-1 h-full">
                  <div className="flex items-start justify-between mb-5">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                      {s.icon}
                    </div>
                    <span className="text-3xl font-bold text-cyan-300 opacity-30 tabular-nums">
                      {s.num}
                    </span>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-2">{s.title}</h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features grid */}
      <section className="py-16 md:py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight">
              Todo lo que necesitás. <span className="text-zinc-500">Nada que no.</span>
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                icon: <Zap className="w-4 h-4" />,
                title: 'Procesamiento en vivo',
                desc: 'Cada pedido pago se etiqueta en segundos.',
              },
              {
                icon: <Mail className="w-4 h-4" />,
                title: 'Aviso al cliente',
                desc: 'Email con la guía DAC y el link de seguimiento.',
              },
              {
                icon: <Wallet className="w-4 h-4" />,
                title: 'Sin suscripción',
                desc: 'Comprás packs en UYU. Pagás solo lo que usás.',
              },
              {
                icon: <Clock className="w-4 h-4" />,
                title: 'Sin caducidad',
                desc: 'Los envíos no expiran. Quedan en tu cuenta para siempre.',
              },
              {
                icon: <MessageSquare className="w-4 h-4" />,
                title: 'Soporte por WhatsApp',
                desc: 'Hablás con personas, no con un bot.',
              },
              {
                icon: <ShieldCheck className="w-4 h-4" />,
                title: 'Datos protegidos',
                desc: 'Tus credenciales DAC encriptadas, nunca expuestas.',
              },
            ].map((f) => (
              <div
                key={f.title}
                className="bg-zinc-900/30 border border-white/[0.04] hover:border-cyan-500/20 rounded-2xl p-5 backdrop-blur-sm transition-colors"
              >
                <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-4">
                  {f.icon}
                </div>
                <h3 className="text-sm font-semibold text-white mb-1">{f.title}</h3>
                <p className="text-xs text-zinc-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="precios" className="py-16 md:py-20 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-widest mb-3">
              <Wallet className="w-3.5 h-3.5" />
              Precios
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight mb-4">
              Pagás solo por lo que usás.
            </h2>
            <p className="text-zinc-400 text-base md:text-lg max-w-2xl mx-auto">
              Sin suscripciones. Sin caducidad. Cuanto más comprás, menos pagás por envío.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 pt-4">
            {PACKS.map((pack) => {
              const isPopular = 'popular' in pack && pack.popular;
              const isBest = 'best' in pack && pack.best;
              const savings =
                pack.pricePerShipmentUyu < REF_PRICE
                  ? Math.round(((REF_PRICE - pack.pricePerShipmentUyu) / REF_PRICE) * 100)
                  : 0;
              const anchorPrice = pack.shipments * REF_PRICE;
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
                  {(isBest || isPopular) && (
                    <div
                      className={`absolute inset-0 rounded-2xl opacity-60 group-hover:opacity-100 transition-opacity pointer-events-none ${
                        isBest
                          ? 'bg-gradient-to-br from-amber-500/40 via-orange-500/20 to-amber-500/40'
                          : 'bg-gradient-to-br from-cyan-500/40 via-cyan-400/20 to-cyan-500/40'
                      }`}
                    />
                  )}
                  <div
                    className={`relative m-[1px] rounded-2xl p-6 h-full flex flex-col ${
                      isBest || isPopular
                        ? 'bg-zinc-950/95'
                        : 'bg-zinc-900/40 border border-white/[0.06] group-hover:border-white/[0.12]'
                    } backdrop-blur-xl transition-colors`}
                  >
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

                    <div className="flex items-start justify-between mb-5 mt-2">
                      <div
                        className={`inline-flex items-center justify-center w-11 h-11 rounded-xl border ${
                          isBest
                            ? 'bg-gradient-to-br from-amber-500/20 to-orange-500/5 border-amber-500/20'
                            : isPopular
                              ? 'bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 border-cyan-500/20'
                              : 'bg-zinc-800/80 border-white/[0.06]'
                        }`}
                      >
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
                      {savings > 0 && (
                        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-semibold">
                          <TrendingDown className="w-3 h-3" />-{savings}%
                        </div>
                      )}
                    </div>

                    <div className="mb-5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-bold text-white tabular-nums tracking-tight">
                          {pack.shipments.toLocaleString('es-UY')}
                        </span>
                        <span className="text-sm font-medium text-zinc-400">envíos</span>
                      </div>
                      <p className="text-xs text-zinc-500 mt-1.5">{pack.tagline}</p>
                    </div>

                    <div className="border-y border-white/[0.06] py-4 mb-5">
                      {anchorPrice > pack.totalPriceUyu && (
                        <p className="text-[11px] text-zinc-600 line-through mb-1 tabular-nums">
                          Antes ${anchorPrice.toLocaleString('es-UY')} UYU
                        </p>
                      )}
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-zinc-500 text-sm">$</span>
                        <span className="text-4xl font-bold text-white tabular-nums tracking-tight">
                          {pack.totalPriceUyu.toLocaleString('es-UY')}
                        </span>
                        <span className="text-xs text-zinc-500 font-medium">UYU</span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1.5">
                        <span
                          className={`font-semibold ${
                            isBest ? 'text-amber-400' : 'text-cyan-400'
                          }`}
                        >
                          ${pack.pricePerShipmentUyu}
                        </span>{' '}
                        UYU por envío
                      </p>
                    </div>

                    <ul className="space-y-2.5 mb-6">
                      <FeatureLi>Acreditación instantánea</FeatureLi>
                      <FeatureLi>Sin caducidad ni renovación</FeatureLi>
                      <FeatureLi>Soporte por WhatsApp</FeatureLi>
                    </ul>

                    <TrackedSignupLink
                      href="/signup"
                      ctaLocation="pricing"
                      className={`block text-center py-3 rounded-xl text-sm font-semibold transition-all mt-auto ${
                        isBest
                          ? 'bg-gradient-to-r from-amber-500 to-orange-400 hover:from-amber-400 hover:to-orange-300 text-zinc-950 shadow-lg shadow-amber-500/20 hover:shadow-amber-500/40'
                          : isPopular
                            ? 'bg-gradient-to-r from-cyan-500 to-cyan-400 hover:from-cyan-400 hover:to-cyan-300 text-zinc-950 shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40'
                            : 'bg-white/[0.04] hover:bg-white/[0.08] text-white border border-white/[0.08] hover:border-cyan-500/30'
                      }`}
                    >
                      Crear cuenta y comprar
                    </TrackedSignupLink>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-center text-xs text-zinc-500 mt-8">
            Pago único con MercadoPago en pesos uruguayos. Los envíos se acreditan al instante.
          </p>
        </div>
      </section>

      {/* Referrals */}
      <section id="referidos" className="py-16 md:py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="relative overflow-hidden rounded-3xl">
            <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 via-transparent to-emerald-500/10" />
            <div className="absolute -top-24 -left-24 w-96 h-96 bg-cyan-500/20 rounded-full blur-3xl" />
            <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-emerald-500/20 rounded-full blur-3xl" />
            <div className="relative bg-zinc-950/70 backdrop-blur-xl border border-white/[0.06] rounded-3xl p-8 md:p-12">
              <div className="text-center mb-12">
                <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-widest mb-3">
                  <Gift className="w-3.5 h-3.5" />
                  Programa de referidos
                </div>
                <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight mb-4">
                  Compartí y{' '}
                  <span className="bg-gradient-to-r from-cyan-300 to-emerald-300 bg-clip-text text-transparent">
                    ganá envíos gratis
                  </span>
                </h2>
                <p className="text-zinc-400 text-base md:text-lg max-w-2xl mx-auto">
                  Por cada amigo que se registre con tu link recibís el{' '}
                  <span className="text-emerald-300 font-semibold">20%</span> de todo lo que compre
                  — para siempre.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
                {[
                  {
                    num: 1,
                    icon: <Send className="w-5 h-5" />,
                    title: 'Compartí tu link',
                    desc: 'Mandalo por WhatsApp a otros emprendedores con Shopify.',
                  },
                  {
                    num: 2,
                    icon: <ShoppingCart className="w-5 h-5" />,
                    title: 'Tu referido compra',
                    desc: 'Arranca con 10 envíos gratis y compra packs cuando los necesite.',
                  },
                  {
                    num: 3,
                    icon: <Plus className="w-5 h-5" />,
                    title: 'Vos ganás 20%',
                    desc: 'Cada pack que compre te suma envíos gratis — para siempre.',
                  },
                ].map((s) => (
                  <div
                    key={s.num}
                    className="bg-zinc-900/50 border border-white/[0.06] rounded-2xl p-5 backdrop-blur-sm"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                        {s.icon}
                      </div>
                      <span className="text-3xl font-bold text-cyan-300 opacity-30">
                        0{s.num}
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-white mb-1">{s.title}</h3>
                    <p className="text-xs text-zinc-400 leading-relaxed">{s.desc}</p>
                  </div>
                ))}
              </div>

              {/* Concrete example for psychological anchor */}
              <div className="bg-zinc-900/50 border border-emerald-500/20 rounded-2xl p-6 max-w-2xl mx-auto">
                <div className="flex items-center gap-2 text-xs text-emerald-300 font-medium uppercase tracking-wider mb-2">
                  <Sparkles className="w-3.5 h-3.5" />
                  Ejemplo
                </div>
                <p className="text-zinc-300 text-sm md:text-base leading-relaxed">
                  Si <span className="font-semibold text-white">5 referidos</span> compran el pack
                  de 250 envíos, vos ganás{' '}
                  <span className="font-semibold text-emerald-300">250 envíos gratis</span>. Eso
                  son <span className="text-emerald-300 font-semibold">$3.000 UYU</span> en envíos
                  para tu tienda.
                </p>
              </div>

              <div className="text-center mt-10">
                <TrackedSignupLink
                  href="/signup"
                  ctaLocation="referrals"
                  className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-7 py-3.5 rounded-xl text-sm font-semibold transition-all shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/40 hover:-translate-y-0.5"
                >
                  Crear cuenta y obtener tu link
                  <ArrowRight className="w-4 h-4" />
                </TrackedSignupLink>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-16 md:py-20 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-widest mb-3">
              <MessageSquare className="w-3.5 h-3.5" />
              Preguntas frecuentes
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight">
              Lo que todos preguntan
            </h2>
          </div>
          <div className="space-y-3">
            {[
              {
                q: '¿Necesito tarjeta de crédito para empezar?',
                a: 'No. Te registrás y arrancás con 10 envíos gratis. Cuando los uses, comprás un pack con MercadoPago.',
              },
              {
                q: '¿Cómo funciona el pago?',
                a: 'Comprás packs de envíos en pesos uruguayos con MercadoPago. Pagás una sola vez y los envíos quedan en tu cuenta sin caducar.',
              },
              {
                q: '¿Tienen suscripción mensual?',
                a: 'No. Solo pagás cuando comprás un pack. No hay cargos automáticos, cuotas ni cobros recurrentes.',
              },
              {
                q: '¿Qué pasa si no uso todos los envíos?',
                a: 'Quedan en tu cuenta. No expiran. Los usás cuando los necesites.',
              },
              {
                q: '¿Cómo se acreditan los envíos del programa de referidos?',
                a: 'Por cada compra que haga tu referido, automáticamente se te suma el 20% en envíos gratis. Sin tope, para siempre.',
              },
              {
                q: '¿Necesito conocimientos técnicos?',
                a: 'No. Conectás tu Shopify y tu cuenta DAC en menos de 60 segundos. Sin código, sin instalaciones.',
              },
              {
                q: '¿Cómo genera etiquetas si DAC no tiene API pública?',
                a: 'Usamos automatización web supervisada que se comporta como un operario humano. Si DAC actualiza su sitio, nosotros actualizamos los selectores y todo sigue funcionando.',
              },
              {
                q: '¿Mis clientes reciben aviso?',
                a: 'Sí. Cada cliente recibe un email con el número de guía DAC y el link de seguimiento al instante.',
              },
            ].map((faq, i) => (
              <details
                key={i}
                className="group bg-zinc-900/40 border border-white/[0.06] hover:border-white/[0.12] rounded-xl backdrop-blur-sm transition-colors"
              >
                <summary className="cursor-pointer list-none flex items-center justify-between gap-4 p-5">
                  <h3 className="text-sm md:text-base font-semibold text-white">{faq.q}</h3>
                  <Plus className="w-4 h-4 text-zinc-400 flex-shrink-0 group-open:rotate-45 transition-transform" />
                </summary>
                <p className="text-sm text-zinc-400 leading-relaxed px-5 pb-5">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-16 md:py-20 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-cyan-500/[0.15] via-zinc-900 to-emerald-500/[0.10] border border-cyan-500/20 p-10 md:p-16 text-center">
            <div className="absolute -top-32 -left-32 w-96 h-96 bg-cyan-500/20 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />
            <div className="relative">
              <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight mb-4">
                Tu primer envío automático,
                <br />
                <span className="bg-gradient-to-r from-cyan-300 to-emerald-300 bg-clip-text text-transparent">
                  gratis.
                </span>
              </h2>
              <p className="text-zinc-400 text-base md:text-lg max-w-xl mx-auto mb-8">
                Creá tu cuenta, conectá Shopify y mirá cómo se procesa solo tu próximo pedido.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <TrackedSignupLink
                  href="/signup"
                  ctaLocation="final_cta"
                  className="group inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-7 py-3.5 rounded-xl text-sm font-semibold transition-all shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:-translate-y-0.5"
                >
                  Empezar con 10 envíos gratis
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                </TrackedSignupLink>
              </div>
              <p className="text-xs text-zinc-500 mt-5">Sin tarjeta. Sin compromisos.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 px-6 border-t border-white/[0.04]">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-white" />
            </div>
            <p className="text-zinc-500 text-sm">
              Label<span className="text-cyan-400 font-semibold">Flow</span> &mdash; Automatización
              de envíos en Uruguay
            </p>
          </div>
          <div className="flex items-center gap-6">
            <Link
              href="/terminos"
              className="text-zinc-600 hover:text-zinc-300 text-sm transition-colors"
            >
              Términos
            </Link>
            <Link
              href="/privacidad"
              className="text-zinc-600 hover:text-zinc-300 text-sm transition-colors"
            >
              Privacidad
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureLi({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-xs text-zinc-400">
      <div className="mt-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
        <Check className="w-2.5 h-2.5 text-emerald-400" strokeWidth={3} />
      </div>
      {children}
    </li>
  );
}
