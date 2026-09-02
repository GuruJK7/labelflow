import Link from 'next/link';
import {
  Zap,
  ArrowRight,
  Check,
  Store,
  Truck,
  CreditCard,
  FileSpreadsheet,
  Printer,
  Users,
  Gift,
  RefreshCw,
  Sparkles,
  Server,
  Lock,
  Database,
  ScrollText,
  Wallet,
  MessageCircle,
} from 'lucide-react';
import { ScrollReveal } from './_components/ScrollReveal';
import { ScrollProgress } from './_components/ScrollProgress';
import { BatchPrinting } from './_components/BatchPrinting';
import { HeroChaos } from './_components/HeroChaos';
import { TimelineFill } from './_components/TimelineFill';
import { PricingSelector } from './_components/PricingSelector';
import { TRIAL_SHIPMENTS } from '@/lib/trial';
import { SELF_SERVE_PACK_SHIPMENTS, largePacksEnabled } from '@/lib/credit-packs';
import {
  PRICING_TIERS,
  formatUsdUnitMilli,
  formatRate,
  getUsdUyuRateMilli,
  unitPriceUsdMilliFor,
} from '@/lib/pricing';
import { ONBOARDING_STEPS } from '@/lib/onboarding-state';
import type { ReactNode } from 'react';

/** Public brand for the site (autoenvia.com). Internally the platform is LabelFlow;
 *  flip this single constant if the public name ever changes. */
const BRAND = 'AutoEnvía';

/**
 * Precios de la copy estática, EN DÓLARES. Salen de la misma tabla que cobra el
 * checkout (`PRICING_TIERS`) en vez de escribirse a mano: si mañana se mueve un
 * escalón, la landing cambia sola y no queda mintiendo.
 *
 * Van en dólares y no en pesos a propósito. El tarifario está denominado en USD
 * (D35) y el peso depende de `USD_UYU_RATE`, que es env de servidor: un número
 * en pesos horneado en el texto estático se desactualiza en silencio la primera
 * vez que Adrian mueve el tipo. Los pesos se muestran donde el usuario puede
 * elegir la moneda y el tipo viaja con ellos (el simulador).
 */
const LIST_PRICE_USD = formatUsdUnitMilli(PRICING_TIERS[0].unitPriceUsdMilli);
/** El escalón más barato que se puede comprar solo (arriba de eso es a medida). */
const LOWEST_PRICE_USD = formatUsdUnitMilli(
  unitPriceUsdMilliFor(SELF_SERVE_PACK_SHIPMENTS[SELF_SERVE_PACK_SHIPMENTS.length - 1]),
);

/** Minutos de configuración: la suma de las estimaciones que ve el usuario en el
 *  asistente (lib/onboarding-state.ts) da 8,5 → "menos de 10 minutos". */
const SETUP_STEPS = ONBOARDING_STEPS.length;

/** Contacto discreto del pie. NO es el camino de conversión: el alta es
 *  self-serve, así que el mensaje pre-armado ya no habla de coordinar llamadas
 *  ni de evaluar implementaciones. */
const WHATSAPP_URL =
  'https://wa.me/59898943949?text=' +
  encodeURIComponent(`Hola, tengo una consulta sobre ${BRAND}.`);

export const metadata = {
  title: `${BRAND} — Despachá con DAC sin cargar una guía a mano`,
  description:
    'Conectás tu tienda Shopify y cada pedido pago sale con la guía de DAC emitida, el PDF listo para imprimir y el seguimiento cargado. 5 envíos de prueba al crear la cuenta. Después pagás por envío, sin suscripción.',
};

export default function LandingPage() {
  return (
    <div className="lop-landing relative min-h-screen bg-[#050505] overflow-x-clip text-white">
      <ScrollProgress />

      {/* Fondo: grilla + orbes ambientales. Decorativo. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 grid-pattern opacity-[0.35]" />
        <div className="absolute -top-40 left-1/3 w-[600px] h-[600px] bg-cyan-500/[0.12] rounded-full blur-[120px] animate-float-slow" />
        <div className="absolute top-[40%] -right-32 w-[500px] h-[500px] bg-emerald-500/[0.07] rounded-full blur-[120px] animate-float-slower" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-indigo-500/[0.05] rounded-full blur-[120px] animate-float-slow" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#050505]" />
      </div>

      {/* ── Nav ────────────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 w-full z-50 bg-[#050505]/70 backdrop-blur-xl border-b border-white/[0.04]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20 group-hover:shadow-cyan-500/40 transition-shadow">
              <Zap className="w-4 h-4 text-white" aria-hidden />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-display font-bold text-white text-[15px] tracking-tight">
                Auto<span className="text-cyan-400">Envía</span>
              </span>
              <span className="hidden sm:inline font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-400 font-medium">
                Envíos con DAC
              </span>
            </div>
          </Link>

          <div className="hidden lg:flex items-center gap-7 xl:gap-8 text-[13px] text-zinc-400">
            <a href="#como-funciona" className="hover:text-white transition-colors">
              Cómo funciona
            </a>
            <a href="#plataforma" className="hover:text-white transition-colors">
              Plataforma
            </a>
            <a href="#precios" className="hover:text-white transition-colors">
              Precios
            </a>
            <a href="#faq" className="hover:text-white transition-colors">
              Preguntas
            </a>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Debajo de sm el logo + dos botones no entran en 375px y se pisan.
                Queda sólo el primario: el hero repite "Iniciar sesión" justo
                abajo, así que no se pierde el acceso a la cuenta. */}
            <Link
              href="/login"
              className="hidden sm:inline-flex border border-white/10 text-zinc-200 hover:bg-white/[0.04] hover:border-white/20 px-3 sm:px-4 py-2 rounded-lg text-[12px] sm:text-[13px] font-semibold transition-colors"
            >
              Iniciar sesión
            </Link>
            <Link
              href="/signup"
              className="bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-3 sm:px-4 py-2 rounded-lg text-[12px] sm:text-[13px] font-semibold transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/50 hover:-translate-y-0.5"
            >
              Crear cuenta gratis
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="relative min-h-[100svh] flex flex-col items-center justify-center px-4 sm:px-6 pt-28 pb-24 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute top-24 left-0 right-0 h-px overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent animate-beam" />
        </div>

        <HeroChaos />

        <div className="relative z-10 max-w-5xl mx-auto text-center">
          <ScrollReveal variant="up" delay={0}>
            <div className="inline-flex items-center gap-2.5 rounded-full border border-cyan-400/25 bg-gradient-to-b from-cyan-400/[0.08] to-cyan-400/[0.02] px-4 py-1.5 mb-7 sm:mb-8 backdrop-blur-sm">
              <Truck className="w-3.5 h-3.5 text-cyan-300" aria-hidden />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-cyan-300">
                Uruguay · envíos con DAC
              </span>
            </div>
          </ScrollReveal>

          <ScrollReveal variant="up" delay={100}>
            <h1 className="font-display text-[2.4rem] sm:text-5xl md:text-[4.4rem] font-extrabold text-white leading-[1.05] tracking-tight mb-6">
              Dejá de cargar guías
              <br />
              de DAC{' '}
              <span className="bg-gradient-to-r from-cyan-300 via-cyan-400 to-emerald-300 bg-clip-text text-transparent animate-gradient">
                a mano.
              </span>
            </h1>
          </ScrollReveal>

          <ScrollReveal variant="up" delay={200}>
            <p className="text-base sm:text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
              Conectás tu tienda y cada pedido pago sale con la guía emitida en DAC, el PDF listo
              para imprimir y el pedido marcado como preparado{' '}
              <span className="text-zinc-200 font-medium">con su número de seguimiento.</span>
            </p>
          </ScrollReveal>

          <ScrollReveal variant="up" delay={300}>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                href="/signup"
                className="group inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-7 py-3.5 rounded-xl text-sm font-semibold transition-all shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/60 hover:-translate-y-0.5 glow-cyan w-full sm:w-auto justify-center"
              >
                Crear cuenta gratis
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" aria-hidden />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 border border-white/10 text-zinc-200 px-6 py-3.5 rounded-xl text-sm font-semibold hover:bg-white/[0.04] hover:border-white/20 transition-colors w-full sm:w-auto justify-center"
              >
                Iniciar sesión
              </Link>
            </div>
            <p className="mt-5 text-[13px] text-zinc-400">
              {TRIAL_SHIPMENTS} envíos de prueba al crear la cuenta. No pedimos tarjeta.
            </p>
          </ScrollReveal>

          <ScrollReveal variant="up" delay={400}>
            <div className="flex flex-wrap items-center justify-center gap-x-4 sm:gap-x-6 gap-y-2 mt-7 sm:mt-8 text-[11px] sm:text-xs text-zinc-400">
              <span className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden />
                Se instala desde Shopify
              </span>
              <span className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden />
                Las guías salen con tu cuenta de DAC
              </span>
              <span className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden />
                Sin suscripción
              </span>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── Integraciones ──────────────────────────────────────────────────── */}
      <section className="relative border-y border-white/[0.06] px-4 sm:px-6 py-10 sm:py-12 overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(600px_200px_at_50%_0%,rgba(34,211,238,0.05),transparent_70%)]"
        />
        <ScrollReveal>
          <div className="relative max-w-5xl mx-auto">
            <p className="text-center font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-400 mb-7">
              Con lo que se conecta
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <IntegrationCard
                icon={<Store className="w-4 h-4" aria-hidden />}
                name="Shopify"
                detail="La app se instala desde tu tienda. Los pedidos pagos entran al instante."
              />
              <IntegrationCard
                icon={<Truck className="w-4 h-4" aria-hidden />}
                name="DAC"
                detail="Con tu cuenta de dac.com.uy. La guía y el seguimiento salen a tu nombre."
              />
              <IntegrationCard
                icon={<FileSpreadsheet className="w-4 h-4" aria-hidden />}
                name="Tu correo saliente"
                detail="Opcional: al emitirse la guía le llega un mail al comprador con el seguimiento."
              />
              <IntegrationCard
                icon={<CreditCard className="w-4 h-4" aria-hidden />}
                name="MercadoPago"
                detail="Sólo para que compres tus envíos. Pago único, no una suscripción."
              />
            </div>
          </div>
        </ScrollReveal>
      </section>

      {/* ── Tres números que sí se pueden sostener ─────────────────────────── */}
      <section className="px-4 sm:px-6 py-12 sm:py-16">
        <ScrollReveal>
          <div className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-4">
            <BigStat
              value={String(TRIAL_SHIPMENTS)}
              label="envíos de prueba"
              detail="Se acreditan solos al crear la cuenta."
            />
            <BigStat
              value={String(SETUP_STEPS)}
              label="pasos de configuración"
              detail="El asistente te lleva por todos. Menos de 10 minutos."
            />
            <BigStat
              value={`USD ${LOWEST_PRICE_USD}`}
              label="por envío, el más barato"
              detail={`Baja de USD ${LIST_PRICE_USD} a USD ${LOWEST_PRICE_USD} según el volumen.`}
            />
          </div>
        </ScrollReveal>
      </section>

      {/* ── Cómo funciona ──────────────────────────────────────────────────── */}
      <section id="como-funciona" className="px-4 sm:px-6 py-16 md:py-24 scroll-mt-20">
        <div className="max-w-4xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center max-w-2xl mx-auto mb-12 sm:mb-16">
              <span aria-hidden className="lop-ghost">
                01
              </span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <Sparkles className="w-3.5 h-3.5" aria-hidden />
                Cómo funciona
              </div>
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight">
                Lo configurás una vez.{' '}
                <span className="text-zinc-500">Después mirás.</span>
              </h2>
            </div>
          </ScrollReveal>

          <div className="relative pl-11 md:pl-0">
            <TimelineFill />
            <ol className="space-y-10 md:space-y-14">
              {STEPS.map((s, i) => (
                <ScrollReveal key={s.title} variant="up" as="li" delay={i * 60}>
                  <Step index={i} {...s} />
                </ScrollReveal>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ── Plataforma: qué hace, con el detalle que importa ───────────────── */}
      <section id="plataforma" className="px-4 sm:px-6 py-16 md:py-24 scroll-mt-20">
        <div className="max-w-5xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center max-w-2xl mx-auto mb-12">
              <span aria-hidden className="lop-ghost">
                02
              </span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <Printer className="w-3.5 h-3.5" aria-hidden />
                La plataforma
              </div>
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight">
                Lo que se lleva de tu día
              </h2>
              <p className="text-zinc-400 mt-4 leading-relaxed text-sm sm:text-base">
                Nada de esto es una promesa a futuro: es lo que hace hoy la cuenta que creás en el
                paso de arriba.
              </p>
            </div>
          </ScrollReveal>

          <ScrollReveal stagger className="grid md:grid-cols-2 gap-4">
            {FEATURES.map((f) => (
              <Feature key={f.title} {...f} />
            ))}
          </ScrollReveal>

          {/* Demostración: impresión por lote */}
          <ScrollReveal variant="scale">
            <div className="mt-16 sm:mt-20">
              <div className="text-center max-w-2xl mx-auto mb-7">
                <h3 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
                  Las etiquetas del día, en un solo PDF
                </h3>
                <p className="text-zinc-400 mt-3 text-sm sm:text-base leading-relaxed">
                  Elegís las etiquetas de la jornada y bajan unidas en un archivo, hasta 50 por vez.
                  No abrís un PDF por pedido.
                </p>
              </div>
              <BatchPrinting />
              <p className="mt-4 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-400">
                Animación de demostración · no son datos de una cuenta real
              </p>
            </div>
          </ScrollReveal>

          {/* Fundaciones */}
          <ScrollReveal stagger className="mt-16 sm:mt-20 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {FOUNDATIONS.map((f) => (
              <div
                key={f.title}
                className="reveal-item rounded-xl border border-white/[0.07] bg-white/[0.02] p-5 card-lift"
              >
                <div className="flex items-center gap-2 mb-2 text-cyan-400">
                  {f.icon}
                  <h3 className="text-sm font-semibold text-white">{f.title}</h3>
                </div>
                <p className="text-[13px] text-zinc-400 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </ScrollReveal>
        </div>
      </section>

      {/* ── Precios ────────────────────────────────────────────────────────── */}
      <section id="precios" className="px-4 sm:px-6 py-16 md:py-24 scroll-mt-20">
        <div className="max-w-4xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center max-w-2xl mx-auto mb-10">
              <span aria-hidden className="lop-ghost">
                03
              </span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <Wallet className="w-3.5 h-3.5" aria-hidden />
                Precios
              </div>
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight">
                Pagás por envío.{' '}
                <span className="text-zinc-500">Cuantos más, más barato.</span>
              </h2>
              <p className="text-zinc-400 mt-4 leading-relaxed text-sm sm:text-base">
                Comprás un pack de envíos y se descuenta uno por cada guía que sale bien. No hay
                mensualidad ni permanencia.
              </p>
            </div>
          </ScrollReveal>

          <ScrollReveal variant="scale">
            <PricingSelector
              rateMilliValue={Number(getUsdUyuRateMilli())}
              rateLabel={formatRate(getUsdUyuRateMilli())}
              largePacks={largePacksEnabled()}
            />
          </ScrollReveal>

          <ScrollReveal stagger className="mt-8 grid sm:grid-cols-3 gap-3">
            {PRICING_NOTES.map((n) => (
              <div
                key={n.title}
                className="reveal-item rounded-xl border border-white/[0.07] bg-white/[0.02] p-5"
              >
                <div className="flex items-center gap-2 mb-2 text-emerald-400">
                  {n.icon}
                  <h3 className="text-sm font-semibold text-white">{n.title}</h3>
                </div>
                <p className="text-[13px] text-zinc-400 leading-relaxed">{n.body}</p>
              </div>
            ))}
          </ScrollReveal>
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────────────────────── */}
      <section id="faq" className="px-4 sm:px-6 py-16 md:py-24 scroll-mt-20">
        <div className="max-w-3xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center mb-10 sm:mb-12">
              <span aria-hidden className="lop-ghost">
                04
              </span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <ScrollText className="w-3.5 h-3.5" aria-hidden />
                Preguntas frecuentes
              </div>
              <h2 className="font-display text-3xl sm:text-4xl font-bold text-white tracking-tight">
                Lo que preguntan antes de empezar
              </h2>
            </div>
          </ScrollReveal>

          <ScrollReveal stagger className="space-y-3">
            {FAQ.map((item) => (
              <details
                key={item.q}
                className="reveal-item group rounded-xl border border-white/[0.07] bg-white/[0.02] px-5 py-4 transition-colors hover:border-white/[0.14] open:border-cyan-400/25 open:bg-cyan-400/[0.03]"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-[15px] font-semibold text-white marker:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400">
                  {item.q}
                  <span
                    aria-hidden
                    className="shrink-0 text-cyan-400 transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-zinc-400">{item.a}</p>
              </details>
            ))}
          </ScrollReveal>
        </div>
      </section>

      {/* ── Cierre ─────────────────────────────────────────────────────────── */}
      <section className="px-4 sm:px-6 py-20 md:py-28">
        <ScrollReveal variant="scale">
          <div className="relative max-w-3xl mx-auto overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-transparent px-6 py-14 text-center sm:px-12">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(540px_260px_at_50%_-10%,rgba(34,211,238,0.12),transparent_70%)]"
            />
            <div className="relative">
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-white">
                Probalo con {TRIAL_SHIPMENTS} envíos.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-zinc-400 sm:text-base">
                Creás la cuenta, seguís el asistente y despachás. Si no te sirve, no gastaste nada:
                los envíos de prueba van de nuestra parte y no pedimos tarjeta.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Link
                  href="/signup"
                  className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-500 px-7 py-3.5 text-sm font-semibold text-zinc-950 shadow-xl shadow-cyan-500/30 transition-all hover:-translate-y-0.5 hover:bg-cyan-400 hover:shadow-cyan-500/60 sm:w-auto"
                >
                  Crear cuenta gratis
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden />
                </Link>
                <Link
                  href="/login"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-6 py-3.5 text-sm font-semibold text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.04] sm:w-auto"
                >
                  Ya tengo cuenta
                </Link>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.06] px-4 sm:px-6 py-12">
        <div className="mx-auto max-w-6xl">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            <div className="col-span-2 md:col-span-1">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-700">
                  <Zap className="h-3.5 w-3.5 text-white" aria-hidden />
                </div>
                <span className="font-display text-sm font-bold text-white">
                  Auto<span className="text-cyan-400">Envía</span>
                </span>
              </div>
              <p className="mt-3 max-w-[26ch] text-[13px] leading-relaxed text-zinc-400">
                Despacho automático con DAC para tiendas uruguayas.
              </p>
            </div>

            <FooterCol title="Producto">
              <FooterAnchor href="#como-funciona">Cómo funciona</FooterAnchor>
              <FooterAnchor href="#plataforma">Plataforma</FooterAnchor>
              <FooterAnchor href="#precios">Precios</FooterAnchor>
              <FooterAnchor href="#faq">Preguntas</FooterAnchor>
            </FooterCol>

            <FooterCol title="Tu cuenta">
              <FooterLink href="/signup">Crear cuenta gratis</FooterLink>
              <FooterLink href="/login">Iniciar sesión</FooterLink>
            </FooterCol>

            <FooterCol title="Legales y contacto">
              <FooterLink href="/terminos">Términos</FooterLink>
              <FooterLink href="/privacidad">Privacidad</FooterLink>
              <li>
                <a
                  href={WHATSAPP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[13px] text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  <MessageCircle className="h-3.5 w-3.5" aria-hidden />
                  Consultas por WhatsApp
                </a>
              </li>
            </FooterCol>
          </div>

          <p className="mt-10 border-t border-white/[0.06] pt-6 text-[12px] text-zinc-400">
            {BRAND} — Uruguay. DAC, Shopify y MercadoPago son marcas de sus respectivos titulares;
            {BRAND} no está afiliada a ellas.
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ── Contenido ────────────────────────────────────────────────────────────── */

const STEPS: { title: string; body: string; note: string }[] = [
  {
    title: 'Creás la cuenta',
    body: `Con tu correo, en la web. Entrás con ${TRIAL_SHIPMENTS} envíos de prueba ya acreditados y sin haber dejado una tarjeta.`,
    note: 'gratis',
  },
  {
    title: 'Conectás tu tienda',
    body: 'Instalás la app desde tu tienda de Shopify: autorizás los permisos y volvés conectado, sin crear una app privada ni copiar un token de acceso. El asistente te confirma en pantalla que la tienda quedó conectada.',
    note: '2 minutos',
  },
  {
    title: 'Cargás tus datos de DAC y tus reglas',
    body: 'El asistente te pide el usuario y la contraseña con los que entrás a dac.com.uy, quién paga el envío, cuándo el envío es gratis, qué productos se despachan y cada cuánto se procesa.',
    note: `${SETUP_STEPS} pasos`,
  },
  {
    title: 'Se despacha solo',
    body: 'Cada pedido pago genera su guía en DAC, guarda el PDF de la etiqueta y marca el pedido como preparado en tu tienda con el número de seguimiento. Vos entrás cuando querés imprimir.',
    note: 'sin vos',
  },
];

const FEATURES: { title: string; body: string; art: ReactNode }[] = [
  {
    title: 'Se instala desde Shopify',
    body: 'Apretás instalar en tu tienda, autorizás los permisos y volvés con la cuenta conectada. No hay que crear una app privada ni copiar un token de acceso. Si el correo de tu tienda ya tiene cuenta acá, la tienda queda esperando a que entres y la reclames.',
    art: <ArtInstall />,
  },
  {
    title: 'La guía de DAC, hecha',
    body: 'La dirección del pedido se convierte en un envío de DAC con tu propia cuenta. Si la dirección viene ambigua o incompleta, se intenta resolver antes de emitir; si no hay forma de entregarla, el pedido queda marcado para que lo mires vos en vez de salir mal.',
    art: <ArtGuia />,
  },
  {
    title: 'Etiquetas del día en un PDF',
    body: 'Seleccionás las etiquetas de la jornada y se descargan unidas en un solo archivo, hasta 50 por vez. Una impresión, no una por pedido.',
    art: <ArtPdf />,
  },
  {
    title: 'Portal para el depósito, sin login',
    body: 'Si tenés depósito propio o tercerizado, te armamos un link privado para quien empaqueta: ve sólo las etiquetas de tus tiendas, las descarga y marca las que ya imprimió. No necesita usuario ni contraseña, el link no se indexa en buscadores y uno inválido devuelve un 404 común. El link lo generamos nosotros a pedido; todavía no se prende desde tu panel.',
    art: <ArtPortal />,
  },
  {
    title: 'Reglas de envío gratis',
    body: 'Cinco formas de decidir quién no paga el envío: por monto mínimo del pedido, por pedidos seguidos del mismo cliente dentro de una ventana de tiempo, por el envío número N, por etiqueta del cliente o por cantidad de artículos.',
    art: <ArtReglas />,
  },
  {
    title: 'Nunca dos guías del mismo pedido',
    body: 'Antes de emitir, cada corrida saltea los pedidos que ya tienen guía completa —aunque la haya emitido otra tienda tuya—, las direcciones que ya rebotaron y siguen igual, y los envíos que quedaron a medias. Vale para la corrida automática y para la que disparás vos. Nadie termina con dos guías ni con dos cobros de DAC.',
    art: <ArtRetry />,
  },
];

const FOUNDATIONS: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: 'Corre sin tu computadora',
    body: 'El procesamiento vive en nuestros servidores. Los pedidos pagos de Shopify entran por webhook apenas se cobran y además hay una corrida programada.',
    icon: <Server className="h-4 w-4" aria-hidden />,
  },
  {
    title: 'Credenciales cifradas',
    body: 'Tu acceso a DAC y el permiso de tu tienda se guardan cifrados con AES-256-GCM, no en texto plano.',
    icon: <Lock className="h-4 w-4" aria-hidden />,
  },
  {
    title: 'Ningún cliente ve lo de otro',
    body: 'Cada consulta se resuelve contra tu sesión y se valida que la tienda sea tuya antes de responder. Nuestro equipo tiene acceso de operador para destrabarte algo; ningún otro cliente lo tiene.',
    icon: <Database className="h-4 w-4" aria-hidden />,
  },
  {
    title: 'Registro de cada corrida',
    body: 'Queda anotado qué se procesó, qué salió y qué falló, con fecha y detalle, para que puedas reconstruir cualquier día.',
    icon: <ScrollText className="h-4 w-4" aria-hidden />,
  },
  {
    title: 'Varias tiendas, una billetera',
    body: 'Podés tener más de una tienda conectada. Comparten el saldo de envíos y cada una mantiene sus pedidos y sus etiquetas por separado.',
    icon: <Users className="h-4 w-4" aria-hidden />,
  },
  {
    title: 'Aviso al comprador',
    body: 'Si configurás tu correo saliente, al emitirse la guía se le manda un mail al comprador con el seguimiento. Es opcional.',
    icon: <RefreshCw className="h-4 w-4" aria-hidden />,
  },
];

const PRICING_NOTES: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: `Los primeros ${TRIAL_SHIPMENTS}, gratis`,
    body: 'Se acreditan solos al crear la cuenta, una vez por titular. No pedimos tarjeta para dártelos.',
    icon: <Gift className="h-4 w-4" aria-hidden />,
  },
  {
    title: 'Se descuenta si sale bien',
    body: 'Un envío del saldo por cada guía emitida con éxito. Una corrida que no emitió ninguna no te descuenta nada.',
    icon: <Check className="h-4 w-4" aria-hidden />,
  },
  {
    title: 'Sin vencimiento',
    body: 'Los envíos que comprás quedan en tu saldo hasta que los uses. No hay mensualidad que se pierda.',
    icon: <Wallet className="h-4 w-4" aria-hidden />,
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: '¿Necesito una cuenta propia de DAC?',
    a: 'Sí. AutoEnvía despacha con tu usuario y contraseña de dac.com.uy, así que las guías salen a tu nombre y el flete lo arreglás vos con DAC como siempre. Nosotros guardamos ese acceso cifrado y lo usamos sólo para emitir tus envíos.',
  },
  {
    q: '¿Qué pasa si un pedido falla?',
    a: 'Queda marcado y no se despacha a medias. Si el problema es la dirección, el pedido va a revisión: lo corregís en tu tienda y la corrida siguiente lo vuelve a tomar solo. Si se trabó por otra cosa, escribinos y lo destrabamos nosotros (hoy eso no se resuelve desde tu panel). En ningún caso se emite dos veces: una corrida nunca vuelve a emitir un pedido que ya tiene guía completa, así que DAC no te lo cobra de nuevo.',
  },
  {
    q: '¿Tengo que dejar la computadora prendida?',
    a: 'No. El procesamiento corre en nuestros servidores: los pedidos pagos de Shopify entran por webhook apenas se cobran y además hay una corrida programada. Tu computadora la usás sólo para imprimir las etiquetas.',
  },
  {
    q: '¿Sirve si no vendo por Shopify?',
    a: 'Hoy, no del todo. El alta que hacés solo conecta tiendas de Shopify. Existe un segundo camino —cargás los pedidos desde un Excel en el Dashboard de AutoEnvía y los levantamos de ahí— pero ese acceso todavía te lo habilitamos nosotros a mano: no lo podés activar desde el asistente. Si vendés por fuera de Shopify, escribinos antes de crear la cuenta.',
  },
  {
    q: '¿Cómo se cobra?',
    a: `Comprás un pack de envíos por MercadoPago, con un pago único, y se descuenta un envío por cada guía emitida con éxito. Cuanto más grande el pack, más barato el envío: va de USD ${LIST_PRICE_USD} a USD ${LOWEST_PRICE_USD} por envío, y el cobro se hace en pesos al tipo de cambio de referencia que publicamos en el simulador. No hay mensualidad ni cobro automático al mes siguiente.`,
  },
  {
    q: '¿Puedo tener varias tiendas?',
    a: 'Sí. Todas las tiendas de tu usuario comparten el mismo saldo de envíos, y cada una mantiene sus pedidos, sus etiquetas y sus métricas por separado. Hay un panel para verlas juntas.',
  },
  {
    q: '¿Mis datos están seguros?',
    a: 'Tu acceso a DAC y el permiso de tu tienda se guardan cifrados con AES-256-GCM. Ningún cliente puede ver los datos de otro: cada consulta se resuelve contra tu sesión y se valida que la tienda sea tuya antes de responder. Sí tenemos acceso de operador nosotros, que es lo que nos deja destrabarte un envío cuando pasa algo; queda registro de cada corrida. El tratamiento de datos personales sigue nuestra política de privacidad, alineada con la Ley 18.331.',
  },
  {
    q: '¿En qué se diferencia de cargarlo a mano?',
    a: 'En que no abrís el sitio de DAC, no volvés a tipear una dirección que ya está en el pedido, no imprimís de a un PDF por vez y no tenés que acordarte de marcar el pedido como preparado con el seguimiento. Eso último se hace solo, en tu tienda.',
  },
  {
    q: '¿Cuánto tardo en dejarlo andando?',
    a: `El asistente son ${SETUP_STEPS} pasos y las estimaciones que muestra suman menos de diez minutos, siempre que tengas a mano el acceso a tu cuenta de DAC. La cuenta queda activa cuando terminás el asistente, no antes: ese último paso es el que la enciende.`,
  },
  {
    q: '¿Puedo cancelar?',
    a: 'No hay contrato ni suscripción que cancelar, porque no cobramos por mes. Comprás envíos cuando los necesitás; si dejás de comprar, dejás de gastar. Los envíos que ya compraste quedan en tu saldo y no vencen.',
  },
];

/* ── Piezas ───────────────────────────────────────────────────────────────── */

function IntegrationCard({
  icon,
  name,
  detail,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-center gap-2 text-cyan-400">
        {icon}
        <span className="font-display text-[13px] font-bold text-white">{name}</span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-zinc-400">{detail}</p>
    </div>
  );
}

function BigStat({ value, label, detail }: { value: string; label: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6 text-center">
      <p className="font-mono text-[clamp(28px,4.5vw,40px)] font-semibold leading-none tracking-tight text-cyan-400 tabular">
        {value}
      </p>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-400">
        {label}
      </p>
      <p className="mt-2.5 text-[13px] leading-relaxed text-zinc-400">{detail}</p>
    </div>
  );
}

function Step({
  index,
  title,
  body,
  note,
}: {
  index: number;
  title: string;
  body: string;
  note: string;
}) {
  return (
    <div className="relative md:grid md:grid-cols-2 md:gap-12">
      <div
        aria-hidden
        className="absolute -left-11 top-0 flex h-9 w-9 items-center justify-center rounded-full border border-cyan-400/30 bg-[#050505] font-mono text-[13px] font-semibold text-cyan-400 md:left-1/2 md:-translate-x-1/2"
      >
        {index + 1}
      </div>
      <div className={index % 2 === 0 ? 'md:pr-4 md:text-right' : 'md:col-start-2 md:pl-4'}>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-400">
          Paso {index + 1} · {note}
        </span>
        <h3 className="mt-2 font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
          {title}
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">{body}</p>
      </div>
    </div>
  );
}

function Feature({ title, body, art }: { title: string; body: string; art: ReactNode }) {
  return (
    <article className="reveal-item card-lift flex flex-col rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6">
      <div className="mb-5 overflow-hidden rounded-xl border border-white/[0.06] bg-[#08090b] p-4">
        {art}
      </div>
      <h3 className="font-display text-lg font-bold tracking-tight text-white">{title}</h3>
      <p className="mt-2.5 text-[13.5px] leading-relaxed text-zinc-400">{body}</p>
    </article>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-400">{title}</h2>
      <ul className="mt-3 space-y-2">{children}</ul>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <Link href={href} className="text-[13px] text-zinc-400 transition-colors hover:text-zinc-200">
        {children}
      </Link>
    </li>
  );
}

function FooterAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <a href={href} className="text-[13px] text-zinc-400 transition-colors hover:text-zinc-200">
        {children}
      </a>
    </li>
  );
}

/* ── Ilustraciones ────────────────────────────────────────────────────────────
   No hay capturas del producto en el repo y no se inventan pantallas con datos
   de clientes: cada tarjeta lleva un esquema en SVG del mismo sistema visual.
   Son decorativas (el texto de al lado dice todo), así que van aria-hidden.
   ──────────────────────────────────────────────────────────────────────────── */

const SVG = 'w-full h-[104px]';

function ArtInstall() {
  return (
    <svg viewBox="0 0 260 104" className={SVG} role="presentation" aria-hidden focusable="false">
      <rect x="8" y="26" width="86" height="52" rx="8" fill="none" stroke="#ffffff1f" />
      <text x="51" y="48" textAnchor="middle" fill="#a1a1aa" fontSize="9" fontFamily="monospace">
        tu tienda
      </text>
      <rect x="24" y="56" width="54" height="14" rx="4" fill="#22d3ee" opacity="0.85" />
      <text x="51" y="66" textAnchor="middle" fill="#062028" fontSize="8" fontFamily="monospace">
        Instalar
      </text>
      <path d="M100 52 h56" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4 4" />
      <path d="M150 47 l7 5 l-7 5" fill="none" stroke="#22d3ee" strokeWidth="1.5" />
      <rect x="164" y="26" width="88" height="52" rx="8" fill="none" stroke="#22d3ee55" />
      <circle cx="208" cy="48" r="9" fill="none" stroke="#34d399" strokeWidth="1.5" />
      <path d="M204 48 l3 3 l6 -6" fill="none" stroke="#34d399" strokeWidth="1.5" />
      <text x="208" y="70" textAnchor="middle" fill="#34d399" fontSize="8" fontFamily="monospace">
        conectada
      </text>
    </svg>
  );
}

function ArtGuia() {
  return (
    <svg viewBox="0 0 260 104" className={SVG} role="presentation" aria-hidden focusable="false">
      <rect x="8" y="20" width="104" height="64" rx="8" fill="none" stroke="#ffffff1f" />
      <text x="20" y="38" fill="#71717a" fontSize="8" fontFamily="monospace">
        pedido
      </text>
      {[48, 58, 68].map((y, i) => (
        <rect key={y} x="20" y={y} width={78 - i * 18} height="4" rx="2" fill="#ffffff1a" />
      ))}
      <path d="M118 52 h30" stroke="#22d3ee" strokeWidth="1.5" />
      <path d="M142 47 l7 5 l-7 5" fill="none" stroke="#22d3ee" strokeWidth="1.5" />
      <rect x="156" y="20" width="96" height="64" rx="8" fill="none" stroke="#22d3ee55" />
      <text x="168" y="38" fill="#22d3ee" fontSize="8" fontFamily="monospace">
        guía DAC
      </text>
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
        <rect
          key={i}
          x={168 + i * 7}
          y="48"
          width={i % 3 === 0 ? 3 : 1.5}
          height="20"
          fill="#e4e4e7"
          opacity="0.75"
        />
      ))}
      <text x="168" y="78" fill="#71717a" fontSize="7" fontFamily="monospace">
        seguimiento
      </text>
    </svg>
  );
}

function ArtPdf() {
  return (
    <svg viewBox="0 0 260 104" className={SVG} role="presentation" aria-hidden focusable="false">
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          x={12 + i * 16}
          y={20 + i * 4}
          width="42"
          height="54"
          rx="5"
          fill="#0d0f12"
          stroke="#ffffff1a"
        />
      ))}
      <path d="M110 52 h34" stroke="#22d3ee" strokeWidth="1.5" />
      <path d="M138 47 l7 5 l-7 5" fill="none" stroke="#22d3ee" strokeWidth="1.5" />
      <rect x="156" y="16" width="72" height="72" rx="8" fill="#0d0f12" stroke="#22d3ee66" />
      <text x="192" y="48" textAnchor="middle" fill="#22d3ee" fontSize="13" fontFamily="monospace">
        PDF
      </text>
      <text x="192" y="64" textAnchor="middle" fill="#71717a" fontSize="8" fontFamily="monospace">
        1 archivo
      </text>
    </svg>
  );
}

function ArtPortal() {
  return (
    <svg viewBox="0 0 260 104" className={SVG} role="presentation" aria-hidden focusable="false">
      <rect x="10" y="18" width="240" height="68" rx="8" fill="none" stroke="#ffffff1f" />
      <rect x="10" y="18" width="240" height="18" rx="8" fill="#ffffff08" />
      <text x="22" y="31" fill="#71717a" fontSize="8" fontFamily="monospace">
        /cliente/•••••••••
      </text>
      <rect x="196" y="23" width="42" height="9" rx="4" fill="#34d39926" />
      <text x="217" y="30" textAnchor="middle" fill="#34d399" fontSize="6" fontFamily="monospace">
        sin login
      </text>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x="22" y={46 + i * 13} width="150" height="9" rx="3" fill="#ffffff12" />
          <circle cx="188" cy={50 + i * 13} r="4" fill="none" stroke="#22d3ee" strokeWidth="1.2" />
          {i < 2 && (
            <path
              d={`M186 ${50 + i * 13} l1.6 1.6 l3.2 -3.4`}
              fill="none"
              stroke="#22d3ee"
              strokeWidth="1.2"
            />
          )}
        </g>
      ))}
      <text x="212" y="53" fill="#52525b" fontSize="6.5" fontFamily="monospace">
        impresa
      </text>
    </svg>
  );
}

function ArtReglas() {
  const rules = ['monto mínimo', 'pedidos seguidos', 'el envío N', 'etiqueta del cliente'];
  return (
    <svg viewBox="0 0 260 104" className={SVG} role="presentation" aria-hidden focusable="false">
      {rules.map((r, i) => (
        <g key={r}>
          <rect
            x="10"
            y={12 + i * 21}
            width="182"
            height="16"
            rx="5"
            fill="#ffffff08"
            stroke="#ffffff14"
          />
          <text x="20" y={23 + i * 21} fill="#a1a1aa" fontSize="8" fontFamily="monospace">
            {r}
          </text>
          <rect x="202" y={12 + i * 21} width="48" height="16" rx="5" fill="#34d39918" />
          <text
            x="226"
            y={23 + i * 21}
            textAnchor="middle"
            fill="#34d399"
            fontSize="7"
            fontFamily="monospace"
          >
            envío 0
          </text>
        </g>
      ))}
    </svg>
  );
}

function ArtRetry() {
  return (
    <svg viewBox="0 0 260 104" className={SVG} role="presentation" aria-hidden focusable="false">
      <text x="10" y="20" fill="#a1a1aa" fontSize="8" fontFamily="monospace">
        cada corrida
      </text>
      {[
        { l: 'ya tiene guía', ok: false },
        { l: 'dirección sin cambios', ok: false },
        { l: 'envío a medias', ok: false },
        { l: 'pedido nuevo', ok: true },
      ].map((row, i) => (
        <g key={row.l}>
          <rect
            x="10"
            y={28 + i * 18}
            width="176"
            height="14"
            rx="4"
            fill={row.ok ? '#22d3ee14' : '#ffffff06'}
            stroke={row.ok ? '#22d3ee55' : '#ffffff12'}
          />
          <text
            x="20"
            y={38 + i * 18}
            fill={row.ok ? '#22d3ee' : '#52525b'}
            fontSize="7.5"
            fontFamily="monospace"
          >
            {row.l}
          </text>
          <text
            x="196"
            y={38 + i * 18}
            fill={row.ok ? '#34d399' : '#52525b'}
            fontSize="7"
            fontFamily="monospace"
          >
            {row.ok ? 'emite' : 'saltea'}
          </text>
        </g>
      ))}
    </svg>
  );
}
