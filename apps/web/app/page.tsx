import Link from 'next/link';
import {
  Zap,
  ArrowRight,
  Check,
  Activity,
  ShieldCheck,
  Clock,
  Truck,
  Server,
  GitBranch,
  LineChart,
  Lock,
  Building2,
  Workflow,
  HeadphonesIcon,
  Cpu,
  Database,
  Boxes,
  Layers,
  Award,
} from 'lucide-react';
import { ScrollReveal } from './_components/ScrollReveal';
import { ScrollProgress } from './_components/ScrollProgress';
import { LivePipeline, OperationVersus, BatchPrinting, ImpactMeters } from './_components/LiveOps';
import { Counter } from './_components/Counter';
import { HeroChaos } from './_components/HeroChaos';
import { ScrollStory } from './_components/ScrollStory';
import { RoiCalculator } from './_components/RoiCalculator';
import { TimelineFill } from './_components/TimelineFill';
import type { ReactNode } from 'react';

/** Public brand for the site (autoenvia.com). Internally the platform is LabelFlow;
 *  flip this single constant if the public name ever changes. */
const BRAND = 'AutoEnvía';

export const metadata = {
  title: `${BRAND} — Logística de envíos automatizada para e-commerce`,
  description:
    'Conectamos tu tienda Shopify con DAC y despachamos cada pedido pago solo: guía emitida en segundos, 24/7, sin intervención manual. Implementación llave en mano y monitoreo permanente.',
};

const WHATSAPP_URL =
  'https://wa.me/59898943949?text=' +
  encodeURIComponent(
    `Hola, vi ${BRAND} y quiero coordinar una llamada para evaluar la implementación en mi operación.`,
  );

export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-[#050505] overflow-x-clip text-white">
      <ScrollProgress />

      {/* Background grid + ambient orbs */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 grid-pattern opacity-[0.35]" />
        <div className="absolute -top-40 left-1/3 w-[600px] h-[600px] bg-cyan-500/[0.12] rounded-full blur-[120px] animate-float-slow" />
        <div className="absolute top-[40%] -right-32 w-[500px] h-[500px] bg-emerald-500/[0.07] rounded-full blur-[120px] animate-float-slower" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-indigo-500/[0.05] rounded-full blur-[120px] animate-float-slow" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#050505]" />
      </div>

      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-[#050505]/70 backdrop-blur-xl border-b border-white/[0.04]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20 group-hover:shadow-cyan-500/40 transition-shadow">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-display font-bold text-white text-[15px] tracking-tight">
                Auto<span className="text-cyan-400">Envía</span>
              </span>
              <span className="hidden sm:inline font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-medium">
                Operación autónoma
              </span>
            </div>
          </Link>
          <div className="hidden lg:flex items-center gap-7 xl:gap-8 text-[13px] text-zinc-400">
            <a href="#operacion" className="hover:text-white transition-colors">
              Operación
            </a>
            <a href="#plataforma" className="hover:text-white transition-colors">
              Plataforma
            </a>
            <a href="#implementacion" className="hover:text-white transition-colors">
              Implementación
            </a>
            <a href="#faq" className="hover:text-white transition-colors">
              FAQ
            </a>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/login"
              className="hidden md:inline text-zinc-400 hover:text-white text-[13px] transition-colors px-2"
            >
              Portal de clientes
            </Link>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-3 sm:px-4 py-2 rounded-lg text-[12px] sm:text-[13px] font-semibold transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/50 hover:-translate-y-0.5"
            >
              Solicitar demo
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative min-h-[100svh] flex flex-col items-center justify-center px-4 sm:px-6 pt-28 pb-28 overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute top-24 left-0 right-0 h-px overflow-hidden"
        >
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent animate-beam" />
        </div>

        <HeroChaos />

        <div className="relative z-10 max-w-5xl mx-auto text-center">
          <ScrollReveal variant="up" delay={0}>
            <div className="inline-flex items-center gap-2.5 rounded-full border border-cyan-400/25 bg-gradient-to-b from-cyan-400/[0.08] to-cyan-400/[0.02] px-4 py-1.5 mb-7 sm:mb-8 backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400" />
              </span>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-cyan-300">
                Operación en vivo · Uruguay
              </span>
            </div>
          </ScrollReveal>

          <ScrollReveal variant="up" delay={100}>
            <h1 className="font-display text-[2.5rem] sm:text-5xl md:text-7xl font-extrabold text-white leading-[1.05] tracking-tight mb-6">
              La logística que
              <br />
              trabaja{' '}
              <span className="bg-gradient-to-r from-cyan-300 via-cyan-400 to-emerald-300 bg-clip-text text-transparent animate-gradient">
                mientras dormís.
              </span>
            </h1>
          </ScrollReveal>

          <ScrollReveal variant="up" delay={200}>
            <p className="text-base sm:text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
              Cada pedido de tu tienda Shopify se valida, se procesa y sale con guía de DAC
              emitida — <span className="text-zinc-200 font-medium">sin que nadie toque nada.</span>
            </p>
          </ScrollReveal>

          <ScrollReveal variant="up" delay={300}>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <a
                href={WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-7 py-3.5 rounded-xl text-sm font-semibold transition-all shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/60 hover:-translate-y-0.5 glow-cyan w-full sm:w-auto justify-center"
              >
                Coordinar una llamada
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </a>
              <a
                href="#operacion"
                className="inline-flex items-center gap-2 border border-white/10 text-zinc-200 px-6 py-3.5 rounded-xl text-sm font-semibold hover:bg-white/[0.04] hover:border-white/20 transition-colors w-full sm:w-auto justify-center"
              >
                Ver la operación en vivo
              </a>
            </div>
          </ScrollReveal>

          <ScrollReveal variant="up" delay={400}>
            <div className="flex flex-wrap items-center justify-center gap-x-4 sm:gap-x-6 gap-y-2 mt-7 sm:mt-8 text-[11px] sm:text-xs text-zinc-500">
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                Integración con Shopify
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                Guía emitida en segundos
              </div>
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                Monitoreo 24/7
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* Social proof — animated counters */}
      <section className="relative border-y border-white/[0.06] px-4 sm:px-6 py-8 sm:py-9 overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(600px_200px_at_50%_0%,rgba(34,211,238,0.05),transparent_70%)]"
        />
        <ScrollReveal>
          <div className="relative max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-7 text-center">
            <ProofStat prefix="+" value={10000} label="pedidos / mes" />
            <ProofStat value={4} label="marcas operando" />
            <ProofStat
              staticValue={
                <>
                  24<span className="text-cyan-400">/</span>7
                </>
              }
              label="procesamiento"
            />
            <ProofStat value={100} suffix="%" label="eficiencia" />
          </div>
        </ScrollReveal>
      </section>

      {/* Scrollytelling — seguí un pedido: el scroll empuja el pedido por el pipeline */}
      <ScrollStory />

      {/* Operación en vivo — pipeline + versus + meters */}
      <section id="live" className="px-4 sm:px-6 pb-20 sm:pb-24">
        <div className="max-w-5xl mx-auto space-y-10 sm:space-y-16">
          <ScrollReveal variant="scale">
            <LivePipeline />
          </ScrollReveal>

          <div>
            <ScrollReveal>
              <div className="flex items-center gap-4 sm:gap-5 mb-5 sm:mb-6">
                <span className="h-px flex-1 bg-white/[0.08]" />
                <span className="font-mono text-[9px] sm:text-[10.5px] uppercase tracking-[0.14em] sm:tracking-[0.24em] text-zinc-500 whitespace-nowrap">
                  El mismo día · dos formas
                </span>
                <span className="h-px flex-1 bg-white/[0.08]" />
              </div>
            </ScrollReveal>
            <ScrollReveal>
              <OperationVersus />
            </ScrollReveal>
          </div>

          <div>
            <ScrollReveal>
              <div className="flex items-center gap-4 sm:gap-5 mb-5 sm:mb-6">
                <span className="h-px flex-1 bg-white/[0.08]" />
                <span className="font-mono text-[9px] sm:text-[10.5px] uppercase tracking-[0.14em] sm:tracking-[0.24em] text-zinc-500 whitespace-nowrap">
                  Las etiquetas · todas de una
                </span>
                <span className="h-px flex-1 bg-white/[0.08]" />
              </div>
            </ScrollReveal>
            <ScrollReveal>
              <BatchPrinting />
            </ScrollReveal>
          </div>

          <ScrollReveal variant="scale">
            <ImpactMeters />
          </ScrollReveal>
        </div>
      </section>

      {/* ROI — Calculá tu ahorro (slider interactivo) */}
      <RoiCalculator whatsappUrl={WHATSAPP_URL} />

      {/* Plataforma */}
      <section id="plataforma" className="py-16 md:py-24 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center mb-12 sm:mb-16">
              <span aria-hidden className="lop-ghost">03</span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <Layers className="w-3.5 h-3.5" />
                La plataforma
              </div>
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight max-w-3xl mx-auto">
                Tres capas que reemplazan{' '}
                <span className="text-zinc-500">a un equipo operativo entero.</span>
              </h2>
            </div>
          </ScrollReveal>

          <ScrollReveal stagger className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              {
                icon: <Workflow className="w-6 h-6" />,
                title: 'Captura inteligente',
                desc:
                  'Webhooks de Shopify + verificación de pago en MercadoPago. Cada orden paga entra a la cola en menos de 5 segundos.',
                points: [
                  'Detección automática de pedidos pagos',
                  'Validación de inventario y dirección',
                  'Reintentos automáticos ante fallos',
                ],
              },
              {
                icon: <Cpu className="w-6 h-6" />,
                title: 'Procesamiento autónomo',
                desc:
                  'Worker dedicado con automatización supervisada. Crea la guía en DAC, descarga el PDF, notifica al cliente.',
                points: [
                  'Resolución de direcciones ambiguas con IA',
                  'Manejo de errores de DAC con retry policy',
                  'Auditoría completa de cada transacción',
                ],
              },
              {
                icon: <LineChart className="w-6 h-6" />,
                title: 'Dashboard ejecutivo',
                desc:
                  'Panel propio con métricas en tiempo real. Tasa de éxito, tiempos, costos, alertas. Tu equipo mira un solo lugar.',
                points: [
                  'KPIs en tiempo real',
                  'Reportes exportables',
                  'Alertas configurables',
                ],
              },
            ].map((c) => (
              <div
                key={c.title}
                className="reveal-item card-lift relative group bg-zinc-900/40 border border-white/[0.06] hover:border-cyan-500/30 rounded-2xl p-6 backdrop-blur-sm hover:shadow-2xl hover:shadow-cyan-500/10"
              >
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-5 group-hover:scale-110 transition-transform">
                  {c.icon}
                </div>
                <h3 className="font-display text-lg font-semibold text-white mb-2">{c.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed mb-4">{c.desc}</p>
                <ul className="space-y-2 pt-4 border-t border-white/[0.05]">
                  {c.points.map((p) => (
                    <li
                      key={p}
                      className="flex items-start gap-2 text-xs text-zinc-400 leading-relaxed"
                    >
                      <Check className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0 mt-0.5" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </ScrollReveal>
        </div>
      </section>

      {/* Para quién es */}
      <section className="py-16 md:py-24 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center mb-12 sm:mb-14">
              <span aria-hidden className="lop-ghost">04</span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <Building2 className="w-3.5 h-3.5" />
                Para quién es
              </div>
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight">
                Diseñado para operaciones{' '}
                <span className="text-zinc-500">que crecen rápido.</span>
              </h2>
            </div>
          </ScrollReveal>

          <ScrollReveal stagger className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              {
                heading: 'Tiendas con volumen',
                body: 'Si despachás más de 100 pedidos al mes y el cuello de botella es la generación manual de guías, te liberamos esas horas.',
              },
              {
                heading: 'Equipos chicos, ambición grande',
                body: 'Operaciones donde la persona que carga DAC también responde clientes, factura y empaca. Quitamos una tarea entera de la lista.',
              },
              {
                heading: 'Escalás sin sumar gente',
                body: 'Llegaste al techo de lo que una persona procesa manualmente. Necesitás escalar sin contratar al área operativa.',
              },
            ].map((p) => (
              <div
                key={p.heading}
                className="reveal-item card-lift bg-zinc-900/30 border border-white/[0.06] hover:border-white/[0.15] rounded-2xl p-6 backdrop-blur-sm"
              >
                <h3 className="font-display text-base font-semibold text-white mb-3">{p.heading}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{p.body}</p>
              </div>
            ))}
          </ScrollReveal>
        </div>
      </section>

      {/* Implementación */}
      <section id="implementacion" className="py-16 md:py-24 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center mb-12 sm:mb-16">
              <span aria-hidden className="lop-ghost">05</span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <Award className="w-3.5 h-3.5" />
                Implementación llave en mano
              </div>
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight max-w-3xl mx-auto">
                Nos encargamos de todo.{' '}
                <span className="text-zinc-500">Vos firmás y empezás a operar.</span>
              </h2>
            </div>
          </ScrollReveal>

          <div className="relative">
            <TimelineFill />
            <div className="space-y-6 md:space-y-10">
              {[
                {
                  num: '01',
                  title: 'Diagnóstico inicial',
                  duration: 'Día 1',
                  desc:
                    'Revisamos tu volumen, tu flujo actual de despachos, los acuerdos con DAC, las particularidades de tu catálogo. Salimos con un plan de implementación firmado.',
                  side: 'left' as const,
                },
                {
                  num: '02',
                  title: 'Setup técnico',
                  duration: 'Días 2 a 5',
                  desc:
                    'Conectamos Shopify a la plataforma. Integramos tu cuenta DAC. Configuramos MercadoPago, webhooks, dominios, certificados. Te creamos tu cuenta en el dashboard ejecutivo.',
                  side: 'right' as const,
                },
                {
                  num: '03',
                  title: 'Pruebas con pedidos reales',
                  duration: 'Días 6 a 8',
                  desc:
                    'Corremos en modo supervisado contra una muestra de tus pedidos reales. Validamos tiempos, calidad de guías y notificaciones. Ajustamos.',
                  side: 'left' as const,
                },
                {
                  num: '04',
                  title: 'Activación y handoff',
                  duration: 'Día 9',
                  desc:
                    'Pasamos a producción. Capacitamos a tu equipo en el dashboard. Quedamos como operadores del servicio con SLA definido.',
                  side: 'right' as const,
                },
              ].map((step) => (
                <ScrollReveal
                  key={step.num}
                  variant={step.side === 'left' ? 'left' : 'right'}
                  className={`relative md:grid md:grid-cols-2 md:gap-12 items-center ${
                    step.side === 'right' ? 'md:[&>*:first-child]:order-2' : ''
                  }`}
                >
                  <div className="card-lift bg-zinc-900/40 border border-white/[0.06] hover:border-cyan-500/25 rounded-2xl p-5 sm:p-6 backdrop-blur-sm relative">
                    <div
                      aria-hidden
                      className={`hidden md:block absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.7)] ${
                        step.side === 'left' ? 'right-[-3.4rem]' : 'left-[-3.4rem]'
                      }`}
                    />
                    <div className="flex items-start gap-4">
                      <span className="font-mono text-3xl font-bold text-cyan-400/40 tabular">
                        {step.num}
                      </span>
                      <div className="flex-1">
                        <div className="flex items-baseline justify-between gap-3 mb-1.5 flex-wrap">
                          <h3 className="font-display text-base sm:text-lg font-semibold text-white">
                            {step.title}
                          </h3>
                          <span className="font-mono text-[10px] uppercase tracking-wider text-cyan-400 font-semibold">
                            {step.duration}
                          </span>
                        </div>
                        <p className="text-sm text-zinc-400 leading-relaxed">{step.desc}</p>
                      </div>
                    </div>
                  </div>
                  <div className="hidden md:block" />
                </ScrollReveal>
              ))}
            </div>
          </div>

          <ScrollReveal>
            <div className="mt-12 text-center">
              <p className="text-sm text-zinc-500">
                Tiempo total promedio:{' '}
                <span className="text-cyan-400 font-semibold">5 a 10 días hábiles</span> desde
                la firma a producción.
              </p>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* Tecnología */}
      <section id="tecnologia" className="py-16 md:py-24 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center mb-12 sm:mb-14">
              <span aria-hidden className="lop-ghost">06</span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <Server className="w-3.5 h-3.5" />
                Tecnología
              </div>
              <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight max-w-3xl mx-auto">
                Construido sobre stack{' '}
                <span className="text-zinc-500">de grado empresarial.</span>
              </h2>
              <p className="text-zinc-400 max-w-2xl mx-auto mt-4 leading-relaxed text-sm sm:text-base">
                No es una integración improvisada. Es una plataforma propietaria con
                tolerancia a fallos, auditoría completa y resolución asistida por IA.
              </p>
            </div>
          </ScrollReveal>

          <ScrollReveal stagger className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                icon: <Boxes className="w-4 h-4" />,
                title: 'Worker dedicado',
                desc:
                  'Procesos paralelos con cola transaccional. Cada pedido se procesa en su contexto aislado.',
              },
              {
                icon: <Cpu className="w-4 h-4" />,
                title: 'Resolución por IA',
                desc:
                  'Direcciones ambiguas, abreviaciones, errores de tipeo. La plataforma los resuelve antes de tocar DAC.',
              },
              {
                icon: <Database className="w-4 h-4" />,
                title: 'Base multi-tenant',
                desc:
                  'Tus datos viven aislados de los de otras operaciones. Cifrado en reposo y en tránsito.',
              },
              {
                icon: <ShieldCheck className="w-4 h-4" />,
                title: 'Credenciales protegidas',
                desc:
                  'Tu API key de Shopify y credenciales DAC quedan cifradas. Nunca expuestas en logs ni en tránsito.',
              },
              {
                icon: <Activity className="w-4 h-4" />,
                title: 'Auditoría completa',
                desc:
                  'Cada transacción queda registrada con timestamps, status, intentos y resultado final.',
              },
              {
                icon: <GitBranch className="w-4 h-4" />,
                title: 'Reintentos inteligentes',
                desc:
                  'Si DAC falla, reintentamos con backoff exponencial. Si la dirección está mal, intentamos correcciones automáticas.',
              },
              {
                icon: <Clock className="w-4 h-4" />,
                title: 'Procesamiento 24/7',
                desc:
                  'Tus pedidos nocturnos se despachan a la madrugada. Nadie depende de horario de oficina.',
              },
              {
                icon: <Lock className="w-4 h-4" />,
                title: 'Cumplimiento legal',
                desc:
                  'Captura de IP, ToS, consentimiento — alineado con la Ley 18.331 (Uruguay) de protección de datos personales.',
              },
              {
                icon: <HeadphonesIcon className="w-4 h-4" />,
                title: 'Soporte directo',
                desc:
                  'Canal de WhatsApp directo con el equipo técnico. Sin tickets ni colas.',
              },
            ].map((f) => (
              <div
                key={f.title}
                className="reveal-item card-lift group bg-zinc-900/30 border border-white/[0.04] hover:border-cyan-500/25 rounded-2xl p-5 backdrop-blur-sm"
              >
                <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-4 group-hover:bg-cyan-500/20 group-hover:scale-110 transition-all">
                  {f.icon}
                </div>
                <h3 className="font-display text-sm font-semibold text-white mb-1.5">{f.title}</h3>
                <p className="text-xs text-zinc-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </ScrollReveal>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-16 md:py-24 px-4 sm:px-6">
        <div className="max-w-3xl mx-auto">
          <ScrollReveal>
            <div className="relative isolate text-center mb-10 sm:mb-12">
              <span aria-hidden className="lop-ghost">07</span>
              <div className="inline-flex items-center gap-2 text-cyan-400 text-[11px] sm:text-xs font-medium uppercase tracking-[0.18em] mb-3 font-mono">
                <Truck className="w-3.5 h-3.5" />
                Preguntas frecuentes
              </div>
              <h2 className="font-display text-3xl sm:text-4xl font-bold text-white tracking-tight">
                Lo que preguntan los equipos serios
              </h2>
            </div>
          </ScrollReveal>

          <ScrollReveal stagger className="space-y-3">
            {[
              {
                q: '¿Qué incluye exactamente la implementación?',
                a: 'Diagnóstico inicial, conexión técnica de Shopify + DAC + MercadoPago, configuración de webhooks y dominios, creación de tu cuenta en el dashboard, pruebas supervisadas con pedidos reales y handoff documentado. El servicio incluye operación continua del sistema una vez activado.',
              },
              {
                q: '¿En cuánto tiempo está operativo?',
                a: 'Entre 5 y 10 días hábiles desde la firma. El tiempo depende de la complejidad de tu catálogo, los acuerdos comerciales con DAC y la coordinación de pruebas con tu equipo.',
              },
              {
                q: '¿Qué pasa si DAC actualiza su sitio?',
                a: 'Nuestro equipo monitorea cambios en la interfaz de DAC y ajusta la plataforma proactivamente. Tu operación no se interrumpe — para vos es transparente.',
              },
              {
                q: '¿Cómo manejan picos de tráfico?',
                a: 'El worker procesa pedidos en paralelo con control de concurrencia. Picos estacionales (Black Friday, fechas patrias) se absorben sin intervención manual ni degradación del servicio.',
              },
              {
                q: '¿Mantienen confidencialidad sobre los datos de mi tienda?',
                a: 'Sí. Firmamos NDA antes de la implementación. Tus datos viven aislados, las credenciales se cifran y nunca se comparten con terceros. Cumplimos con la Ley 18.331 de Uruguay.',
              },
              {
                q: '¿Puedo ver el dashboard antes de contratar?',
                a: 'Sí. En la llamada inicial te mostramos el dashboard en vivo con datos de prueba y te explicamos cada métrica. Es parte del proceso de evaluación.',
              },
              {
                q: '¿Qué pasa si DAC rechaza una dirección?',
                a: 'La plataforma reintenta con correcciones automáticas (normalización, autocompletado, sugerencias por IA). Si persiste, queda marcada para revisión manual y se notifica al equipo. Tu cliente nunca recibe una guía rota.',
              },
              {
                q: '¿Ofrecen SLAs?',
                a: 'Sí, los definimos en el contrato según el volumen y la criticidad de tu operación. Cubren tiempo de respuesta a incidencias y disponibilidad de la plataforma.',
              },
            ].map((faq, i) => (
              <details
                key={i}
                className="reveal-item group bg-zinc-900/40 border border-white/[0.06] hover:border-white/[0.12] rounded-xl backdrop-blur-sm transition-colors"
              >
                <summary className="cursor-pointer list-none flex items-center justify-between gap-4 p-4 sm:p-5">
                  <h3 className="font-display text-sm sm:text-base font-semibold text-white pr-2">
                    {faq.q}
                  </h3>
                  <span className="text-zinc-400 group-open:rotate-45 transition-transform text-xl leading-none flex-shrink-0">
                    +
                  </span>
                </summary>
                <p className="text-sm text-zinc-400 leading-relaxed px-4 sm:px-5 pb-4 sm:pb-5">
                  {faq.a}
                </p>
              </details>
            ))}
          </ScrollReveal>
        </div>
      </section>

      {/* CTA final */}
      <section className="py-16 md:py-24 px-4 sm:px-6">
        <div className="max-w-4xl mx-auto">
          <ScrollReveal variant="scale">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-cyan-500/[0.15] via-zinc-900 to-emerald-500/[0.10] border border-cyan-500/20 p-8 sm:p-10 md:p-16 text-center">
              <div className="absolute -top-32 -left-32 w-96 h-96 bg-cyan-500/20 rounded-full blur-3xl pointer-events-none animate-float-slow" />
              <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none animate-float-slower" />
              <div aria-hidden className="absolute top-0 left-0 right-0 h-px overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent animate-beam" />
              </div>
              <div className="relative">
                <h2 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight mb-4">
                  Hablemos de tu operación.
                </h2>
                <p className="text-zinc-400 text-sm sm:text-base md:text-lg max-w-xl mx-auto mb-7 sm:mb-8 leading-relaxed">
                  30 minutos. Te mostramos la plataforma con datos reales, evaluamos tu caso
                  y definimos si tiene sentido avanzar.
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                  <a
                    href={WHATSAPP_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-7 sm:px-8 py-3.5 sm:py-4 rounded-xl text-sm font-semibold transition-all shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/60 hover:-translate-y-0.5 glow-cyan w-full sm:w-auto justify-center"
                  >
                    Coordinar llamada por WhatsApp
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </a>
                </div>
                <p className="text-[11px] sm:text-xs text-zinc-500 mt-5 sm:mt-6">
                  Atención directa con el equipo técnico · respuesta en horario hábil.
                </p>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 sm:py-10 px-4 sm:px-6 border-t border-white/[0.04]">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-white" />
            </div>
            <p className="text-zinc-500 text-xs sm:text-sm font-display">
              Auto<span className="text-cyan-400 font-semibold">Envía</span>{' '}
              <span className="font-sans text-zinc-600">— logística autónoma para e-commerce</span>
            </p>
          </div>
          <div className="flex items-center gap-4 sm:gap-6 text-xs sm:text-sm">
            <Link href="/terminos" className="text-zinc-600 hover:text-zinc-300 transition-colors">
              Términos
            </Link>
            <Link href="/privacidad" className="text-zinc-600 hover:text-zinc-300 transition-colors">
              Privacidad
            </Link>
            <Link href="/login" className="text-zinc-600 hover:text-zinc-300 transition-colors">
              Portal de clientes
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ProofStat({
  value,
  prefix,
  suffix,
  staticValue,
  label,
}: {
  value?: number;
  prefix?: string;
  suffix?: string;
  staticValue?: ReactNode;
  label: string;
}) {
  return (
    <div>
      <p className="font-mono font-semibold text-[clamp(22px,3.4vw,30px)] tracking-tight text-white tabular">
        {staticValue ?? (
          <>
            {prefix && <span className="text-cyan-400">{prefix}</span>}
            <Counter value={value!} />
            {suffix && <span className="text-cyan-400">{suffix}</span>}
          </>
        )}
      </p>
      <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-zinc-500 mt-1.5">{label}</p>
    </div>
  );
}
