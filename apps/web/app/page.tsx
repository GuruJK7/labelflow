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
  Sparkles,
  Building2,
  Workflow,
  HeadphonesIcon,
  Cpu,
  Database,
  Boxes,
  Layers,
  Award,
} from 'lucide-react';

export const metadata = {
  title: 'LabelFlow — Automatización enterprise de envíos para e-commerce',
  description:
    'Instalamos, configuramos y operamos la logística de envíos de tu tienda Shopify. Integración con DAC, monitoreo 24/7, dashboard ejecutivo en tiempo real.',
};

const WHATSAPP_URL =
  'https://wa.me/59898943949?text=' +
  encodeURIComponent(
    'Hola, vi LabelFlow Enterprise y quiero coordinar una llamada para evaluar la implementación en mi operación.',
  );

export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-[#0a0a0a] overflow-x-hidden">
      {/* Ambient orbs */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute -top-40 left-1/3 w-[600px] h-[600px] bg-cyan-500/[0.08] rounded-full blur-[120px]" />
        <div className="absolute top-[40%] -right-32 w-[500px] h-[500px] bg-emerald-500/[0.05] rounded-full blur-[120px]" />
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-cyan-500/[0.04] rounded-full blur-[120px]" />
      </div>

      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-[#0a0a0a]/70 backdrop-blur-xl border-b border-white/[0.04]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-bold text-white text-[15px] tracking-tight">
                Label<span className="text-cyan-400">Flow</span>
              </span>
              <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-medium">
                Enterprise
              </span>
            </div>
          </Link>
          <div className="hidden md:flex items-center gap-8 text-[13px] text-zinc-400">
            <a href="#plataforma" className="hover:text-white transition-colors">
              Plataforma
            </a>
            <a href="#implementacion" className="hover:text-white transition-colors">
              Implementación
            </a>
            <a href="#tecnologia" className="hover:text-white transition-colors">
              Tecnología
            </a>
            <a href="#faq" className="hover:text-white transition-colors">
              FAQ
            </a>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/login"
              className="text-zinc-400 hover:text-white text-[13px] transition-colors px-2"
            >
              Portal de clientes
            </Link>
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 hover:-translate-y-0.5"
            >
              Solicitar demo
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-36 pb-20 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-gradient-to-r from-cyan-500/10 to-emerald-500/10 border border-cyan-400/20 rounded-full pl-2 pr-4 py-1.5 mb-8 backdrop-blur-sm">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gradient-to-br from-cyan-400 to-emerald-400">
              <Sparkles className="w-3 h-3 text-zinc-950" strokeWidth={3} />
            </span>
            <span className="text-cyan-100 text-xs font-medium tracking-wide">
              Plataforma propietaria · Operación gestionada en Uruguay
            </span>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold text-white leading-[1.05] tracking-tight mb-6">
            Logística de envíos
            <br />
            <span className="bg-gradient-to-r from-cyan-300 via-cyan-400 to-emerald-300 bg-clip-text text-transparent">
              automatizada
            </span>{' '}
            para e-commerce
          </h1>
          <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Instalamos, configuramos y operamos la conexión entre tu tienda Shopify y DAC.
            Cada pedido pago se despacha solo. Vos te enfocás en vender.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-7 py-3.5 rounded-xl text-sm font-semibold transition-all shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:-translate-y-0.5"
            >
              Coordinar una llamada
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </a>
            <a
              href="#plataforma"
              className="inline-flex items-center gap-2 border border-white/10 text-zinc-200 px-6 py-3.5 rounded-xl text-sm font-semibold hover:bg-white/[0.04] hover:border-white/20 transition-colors"
            >
              Ver la plataforma
            </a>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mt-8 text-xs text-zinc-500">
            <div className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              Implementación llave en mano
            </div>
            <div className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              Infraestructura propia
            </div>
            <div className="flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              Monitoreo 24/7
            </div>
          </div>
        </div>
      </section>

      {/* Trust stats — números reales de la operación */}
      <section className="px-6 pb-24">
        <div className="max-w-6xl mx-auto">
          <div className="bg-zinc-900/40 border border-white/[0.06] rounded-2xl backdrop-blur-sm p-8">
            <p className="text-center text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-6">
              Operación en producción
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
              {[
                { value: '24/7', label: 'Monitoreo activo' },
                { value: '< 60s', label: 'Pedido → guía generada' },
                { value: '99.5%', label: 'Uptime infraestructura' },
                { value: '0', label: 'Intervención manual' },
              ].map((s) => (
                <div key={s.label} className="text-center">
                  <p className="text-3xl md:text-4xl font-bold bg-gradient-to-br from-white to-cyan-200 bg-clip-text text-transparent tabular-nums">
                    {s.value}
                  </p>
                  <p className="text-xs text-zinc-500 mt-1.5">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Plataforma — qué hace */}
      <section id="plataforma" className="py-16 md:py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-[0.18em] mb-3">
              <Layers className="w-3.5 h-3.5" />
              La plataforma
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight max-w-3xl mx-auto">
              Tres capas que reemplazan{' '}
              <span className="text-zinc-500">a un equipo operativo entero.</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
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
                  'Worker dedicado con automatización de browser supervisada. Crea la guía en DAC, descarga el PDF, notifica al cliente.',
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
                  'Panel propio con métricas en tiempo real. Tasa de éxito, tiempos, costos, alertas. Tu CEO mira un solo lugar.',
                points: [
                  'KPIs en tiempo real',
                  'Reportes exportables',
                  'Alertas configurables',
                ],
              },
            ].map((c) => (
              <div
                key={c.title}
                className="relative group bg-zinc-900/40 border border-white/[0.06] hover:border-cyan-500/30 rounded-2xl p-6 backdrop-blur-sm transition-all hover:-translate-y-1"
              >
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-5">
                  {c.icon}
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">{c.title}</h3>
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
          </div>
        </div>
      </section>

      {/* Para quién es */}
      <section className="py-16 md:py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-[0.18em] mb-3">
              <Building2 className="w-3.5 h-3.5" />
              Para quién es
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight">
              Diseñado para operaciones{' '}
              <span className="text-zinc-500">que crecen rápido.</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
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
                heading: 'Escalas sin sumar gente',
                body: 'Llegaste al techo de lo que una persona procesa manualmente. Necesitás escalar sin contratar al área operativa.',
              },
            ].map((p) => (
              <div
                key={p.heading}
                className="bg-zinc-900/30 border border-white/[0.06] rounded-2xl p-6 backdrop-blur-sm"
              >
                <h3 className="text-base font-semibold text-white mb-3">{p.heading}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Implementación */}
      <section id="implementacion" className="py-16 md:py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-[0.18em] mb-3">
              <Award className="w-3.5 h-3.5" />
              Implementación llave en mano
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight max-w-3xl mx-auto">
              Nos encargamos de todo.{' '}
              <span className="text-zinc-500">Vos firmás y empezás a operar.</span>
            </h2>
          </div>

          <div className="relative">
            <div
              aria-hidden
              className="hidden md:block absolute left-1/2 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-cyan-500/20 to-transparent"
            />
            <div className="space-y-6 md:space-y-10">
              {[
                {
                  num: '01',
                  title: 'Diagnóstico inicial',
                  duration: 'Día 1',
                  desc:
                    'Revisamos tu volumen, tu flujo actual de despachos, los acuerdos con DAC, las particularidades de tu catálogo. Salimos con un plan de implementación firmado.',
                },
                {
                  num: '02',
                  title: 'Setup técnico',
                  duration: 'Días 2 a 5',
                  desc:
                    'Conectamos Shopify a la plataforma. Integramos tu cuenta DAC. Configuramos MercadoPago, webhooks, dominios, certificados. Te creamos tu cuenta en el dashboard ejecutivo.',
                },
                {
                  num: '03',
                  title: 'Pruebas con pedidos reales',
                  duration: 'Días 6 a 8',
                  desc:
                    'Corremos en modo supervisado contra una muestra de tus pedidos reales. Validamos tiempos, calidad de guías y notificaciones. Ajustamos.',
                },
                {
                  num: '04',
                  title: 'Activación y handoff',
                  duration: 'Día 9',
                  desc:
                    'Pasamos a producción. Capacitamos a tu equipo en el dashboard. Quedamos como operadores del servicio con SLA definido.',
                },
              ].map((step, i) => (
                <div
                  key={step.num}
                  className={`relative md:grid md:grid-cols-2 md:gap-12 items-center ${
                    i % 2 === 0 ? '' : 'md:[&>*:first-child]:order-2'
                  }`}
                >
                  <div className="bg-zinc-900/40 border border-white/[0.06] rounded-2xl p-6 backdrop-blur-sm">
                    <div className="flex items-start gap-4">
                      <span className="text-3xl font-bold text-cyan-400/40 tabular-nums">
                        {step.num}
                      </span>
                      <div className="flex-1">
                        <div className="flex items-baseline justify-between gap-3 mb-1.5 flex-wrap">
                          <h3 className="text-lg font-semibold text-white">{step.title}</h3>
                          <span className="text-[10px] uppercase tracking-wider text-cyan-400 font-semibold">
                            {step.duration}
                          </span>
                        </div>
                        <p className="text-sm text-zinc-400 leading-relaxed">{step.desc}</p>
                      </div>
                    </div>
                  </div>
                  <div className="hidden md:block" />
                </div>
              ))}
            </div>
          </div>

          <div className="mt-12 text-center">
            <p className="text-sm text-zinc-500">
              Tiempo total promedio:{' '}
              <span className="text-cyan-400 font-semibold">5 a 10 días hábiles</span> desde
              la firma a producción.
            </p>
          </div>
        </div>
      </section>

      {/* Tecnología */}
      <section id="tecnologia" className="py-16 md:py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-[0.18em] mb-3">
              <Server className="w-3.5 h-3.5" />
              Tecnología
            </div>
            <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight max-w-3xl mx-auto">
              Construido sobre stack{' '}
              <span className="text-zinc-500">de grado empresarial.</span>
            </h2>
            <p className="text-zinc-400 max-w-2xl mx-auto mt-4 leading-relaxed">
              No es una integración improvisada. Es una plataforma propietaria con
              tolerancia a fallos, auditoría completa y resolución asistida por IA.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                className="bg-zinc-900/30 border border-white/[0.04] hover:border-cyan-500/20 rounded-2xl p-5 backdrop-blur-sm transition-colors"
              >
                <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-4">
                  {f.icon}
                </div>
                <h3 className="text-sm font-semibold text-white mb-1.5">{f.title}</h3>
                <p className="text-xs text-zinc-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparación: a mano vs. con la plataforma */}
      <section className="py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight">
              Lo que cambia en tu operación
            </h2>
            <p className="text-zinc-400 mt-3">
              Sobre una base de 500 envíos al mes.
            </p>
          </div>

          <div className="bg-zinc-900/40 border border-white/[0.06] rounded-2xl backdrop-blur-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                    <th className="text-left py-4 px-6 font-medium text-zinc-400 text-xs uppercase tracking-wider">
                      Variable
                    </th>
                    <th className="text-center py-4 px-6 font-medium text-zinc-500 text-xs uppercase tracking-wider">
                      Operación manual
                    </th>
                    <th className="text-center py-4 px-6 font-medium text-cyan-400 text-xs uppercase tracking-wider">
                      Con LabelFlow
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {[
                    ['Tiempo dedicado por mes', '~25 horas', '0 horas'],
                    ['Errores de tipeo en guías', 'Frecuentes', 'Eliminados'],
                    ['Tiempo del pedido al cliente avisado', '4 a 24 horas', 'Menos de 60 segundos'],
                    ['Operación fuera de horario', 'Imposible', '24/7 automática'],
                    ['Trazabilidad de cada envío', 'Manual', 'Auditoría completa'],
                    ['Escalabilidad a más volumen', 'Limitada al equipo', 'Sin techo técnico'],
                  ].map(([variable, manual, plat]) => (
                    <tr key={variable} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3.5 px-6 text-zinc-300 font-medium">{variable}</td>
                      <td className="py-3.5 px-6 text-center text-zinc-500">{manual}</td>
                      <td className="py-3.5 px-6 text-center text-cyan-300 font-medium">
                        {plat}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-16 md:py-24 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 text-cyan-400 text-xs font-medium uppercase tracking-[0.18em] mb-3">
              <Truck className="w-3.5 h-3.5" />
              Preguntas frecuentes
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight">
              Lo que preguntan los equipos serios
            </h2>
          </div>

          <div className="space-y-3">
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
                className="group bg-zinc-900/40 border border-white/[0.06] hover:border-white/[0.12] rounded-xl backdrop-blur-sm transition-colors"
              >
                <summary className="cursor-pointer list-none flex items-center justify-between gap-4 p-5">
                  <h3 className="text-sm md:text-base font-semibold text-white">{faq.q}</h3>
                  <span className="text-zinc-400 group-open:rotate-45 transition-transform text-xl leading-none">
                    +
                  </span>
                </summary>
                <p className="text-sm text-zinc-400 leading-relaxed px-5 pb-5">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="py-16 md:py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-cyan-500/[0.15] via-zinc-900 to-emerald-500/[0.10] border border-cyan-500/20 p-10 md:p-16 text-center">
            <div className="absolute -top-32 -left-32 w-96 h-96 bg-cyan-500/20 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-emerald-500/15 rounded-full blur-3xl pointer-events-none" />
            <div className="relative">
              <h2 className="text-3xl md:text-5xl font-bold text-white tracking-tight mb-4">
                Hablemos de tu operación.
              </h2>
              <p className="text-zinc-400 text-base md:text-lg max-w-xl mx-auto mb-8 leading-relaxed">
                30 minutos. Te mostramos la plataforma con datos reales, evaluamos tu caso
                y definimos si tiene sentido avanzar.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <a
                  href={WHATSAPP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-8 py-4 rounded-xl text-sm font-semibold transition-all shadow-xl shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:-translate-y-0.5"
                >
                  Coordinar llamada por WhatsApp
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                </a>
              </div>
              <p className="text-xs text-zinc-500 mt-6">
                Atención directa con el equipo técnico · respuesta en horario hábil.
              </p>
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
              Label<span className="text-cyan-400 font-semibold">Flow</span> &mdash;
              Plataforma de logística para e-commerce
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
            <Link
              href="/login"
              className="text-zinc-600 hover:text-zinc-300 text-sm transition-colors"
            >
              Portal de clientes
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
