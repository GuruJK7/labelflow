/**
 * /pricing — landing dedicada para los planes de credit packs (2026-05-15).
 *
 * Antes de hoy los precios estaban enterrados en una FAQ inline del landing.
 * Esta page los muestra arriba, con CTA claros y comparativa contra la
 * alternativa de "hacerlo a mano en DAC".
 *
 * SSR-only — no necesita interactividad client-side, así que evitamos la
 * boundary de Suspense + reducimos el JS shipped al cliente. Los precios
 * vienen de `listPacks()` (single source of truth, mismo array que el
 * webhook de MP consume) → cualquier cambio de precio se refleja acá sin
 * sincronización manual.
 */
import Link from 'next/link';
import {
  Zap,
  ArrowRight,
  Check,
  Package,
  Truck,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { listPacks } from '@/lib/credit-packs';

export const metadata = {
  title: 'Precios — LabelFlow',
  description:
    'Pagás solo por los envíos que despachás. Sin suscripción mensual, sin caducidad. Empezá con 10 envíos gratis.',
};

export default function PricingPage() {
  const packs = listPacks();

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Header */}
      <header className="border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg">
              Label<span className="text-cyan-400">Flow</span>
            </span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/login" className="text-zinc-400 hover:text-white transition-colors">
              Iniciar sesión
            </Link>
            <Link
              href="/signup"
              className="bg-gradient-to-r from-cyan-600 to-cyan-500 px-4 py-2 rounded-lg font-medium hover:shadow-lg hover:shadow-cyan-500/25 transition-all"
            >
              Empezar gratis
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-12 text-center">
        <div className="inline-flex items-center gap-2 bg-cyan-500/10 border border-cyan-500/20 rounded-full px-4 py-1.5 text-xs font-medium text-cyan-400 mb-6">
          <ShieldCheck className="w-3.5 h-3.5" />
          10 envíos gratis al registrarte — sin tarjeta
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
          Pagás solo por los envíos
          <br />
          <span className="text-cyan-400">que despachás</span>
        </h1>
        <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
          Sin suscripción mensual, sin caducidad de saldo. Comprás un pack, cargás créditos
          a tu cuenta, y el worker los va consumiendo a medida que crea guías de DAC.
        </p>
      </section>

      {/* Pricing table */}
      <section className="max-w-6xl mx-auto px-6 pb-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {packs.map((pack) => {
            const isPopular = pack.id === 'pack_100';
            return (
              <div
                key={pack.id}
                className={`relative bg-white/[0.03] border rounded-2xl p-6 transition-all hover:bg-white/[0.05] ${
                  isPopular
                    ? 'border-cyan-500/40 shadow-lg shadow-cyan-500/10'
                    : 'border-white/[0.08]'
                }`}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-cyan-600 to-cyan-500 text-white text-[11px] font-bold uppercase tracking-wide px-3 py-1 rounded-full">
                    Más elegido
                  </div>
                )}
                <div className="mb-4">
                  <div className="text-sm text-zinc-500 mb-1">{pack.label}</div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold">${pack.totalPriceUyu.toLocaleString('es-UY')}</span>
                    <span className="text-zinc-500 text-sm">UYU</span>
                  </div>
                  <div className="text-xs text-cyan-400 mt-1">
                    ${pack.pricePerShipmentUyu} UYU por envío
                  </div>
                </div>
                <ul className="space-y-2 text-sm text-zinc-300 mb-6">
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
                    {pack.shipments} guías DAC automáticas
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
                    PDF descargable + tracking automático
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
                    Email de notificación al cliente
                  </li>
                  <li className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
                    Sin caducidad — usá cuando quieras
                  </li>
                </ul>
                <Link
                  href="/signup"
                  className={`block text-center py-2.5 rounded-xl font-medium text-sm transition-all ${
                    isPopular
                      ? 'bg-gradient-to-r from-cyan-600 to-cyan-500 hover:shadow-lg hover:shadow-cyan-500/25'
                      : 'bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08]'
                  }`}
                >
                  Empezar con este pack
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      {/* Comparison */}
      <section className="max-w-4xl mx-auto px-6 py-12">
        <h2 className="text-2xl font-bold text-center mb-2">
          Comparación: LabelFlow vs hacerlo a mano
        </h2>
        <p className="text-zinc-500 text-center text-sm mb-8">
          Tomando como referencia 100 envíos al mes.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="text-left py-3 px-4 font-medium text-zinc-400">
                  Tarea
                </th>
                <th className="text-center py-3 px-4 font-medium text-zinc-400">
                  A mano en DAC
                </th>
                <th className="text-center py-3 px-4 font-medium text-cyan-400">
                  Con LabelFlow
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              <tr>
                <td className="py-3 px-4 text-zinc-300">
                  Tiempo por guía
                </td>
                <td className="py-3 px-4 text-center text-zinc-500">
                  ~3 minutos
                </td>
                <td className="py-3 px-4 text-center text-cyan-300">
                  0 minutos
                </td>
              </tr>
              <tr>
                <td className="py-3 px-4 text-zinc-300">
                  Tiempo total para 100 envíos
                </td>
                <td className="py-3 px-4 text-center text-zinc-500">
                  5 horas
                </td>
                <td className="py-3 px-4 text-center text-cyan-300">
                  0 horas
                </td>
              </tr>
              <tr>
                <td className="py-3 px-4 text-zinc-300">
                  Riesgo de errores tipográficos
                </td>
                <td className="py-3 px-4 text-center text-zinc-500">
                  Alto
                </td>
                <td className="py-3 px-4 text-center text-cyan-300">
                  Muy bajo
                </td>
              </tr>
              <tr>
                <td className="py-3 px-4 text-zinc-300">
                  Notificación al cliente
                </td>
                <td className="py-3 px-4 text-center text-zinc-500">
                  Manual
                </td>
                <td className="py-3 px-4 text-center text-cyan-300">
                  Automático
                </td>
              </tr>
              <tr>
                <td className="py-3 px-4 text-zinc-300">
                  Tracking en Shopify
                </td>
                <td className="py-3 px-4 text-center text-zinc-500">
                  Manual
                </td>
                <td className="py-3 px-4 text-center text-cyan-300">
                  Automático
                </td>
              </tr>
              <tr>
                <td className="py-3 px-4 text-zinc-300">
                  Costo (100 envíos)
                </td>
                <td className="py-3 px-4 text-center text-zinc-500">
                  Tu tiempo · 5 hrs
                </td>
                <td className="py-3 px-4 text-center text-cyan-300">
                  $1500 UYU
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Feature blocks */}
      <section className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-6">
            <Package className="w-8 h-8 text-cyan-400 mb-3" />
            <h3 className="font-bold mb-2">Pedidos sincronizados</h3>
            <p className="text-sm text-zinc-400">
              Conectás tu tienda Shopify una vez. LabelFlow detecta los pedidos
              nuevos y genera las guías DAC automáticamente.
            </p>
          </div>
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-6">
            <Truck className="w-8 h-8 text-cyan-400 mb-3" />
            <h3 className="font-bold mb-2">Etiquetas listas para imprimir</h3>
            <p className="text-sm text-zinc-400">
              PDFs en tu dashboard apenas la guía se crea. Imprimís en lote
              o de a una, según tu flujo.
            </p>
          </div>
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-6">
            <Mail className="w-8 h-8 text-cyan-400 mb-3" />
            <h3 className="font-bold mb-2">Cliente avisado</h3>
            <p className="text-sm text-zinc-400">
              Email automático al cliente con el código de tracking de DAC
              apenas el envío está despachado.
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-6 py-12">
        <h2 className="text-2xl font-bold text-center mb-8">
          Preguntas frecuentes
        </h2>
        <div className="space-y-4">
          {[
            {
              q: '¿Cuándo me cobran?',
              a: 'Solo cuando comprás un pack. No hay suscripción mensual ni cargos automáticos. Cuando se te terminan los créditos, comprás otro pack — o no, según tu volumen.',
            },
            {
              q: '¿Caducan los créditos?',
              a: 'No. Una vez que comprás un pack, los créditos quedan en tu cuenta sin caducidad. Si no despachás durante meses, siguen ahí cuando vuelvas.',
            },
            {
              q: '¿Qué pasa si DAC no acepta una dirección?',
              a: 'El sistema reintenta con todas las correcciones automáticas que tenemos (tipo "Pocitod" → "Pocitos", recuperar número de puerta, etc.). Si aún así DAC la rechaza, queda en revisión manual y NO te descuenta crédito.',
            },
            {
              q: '¿Cómo conecto Shopify?',
              a: 'Te guiamos en 2 pasos durante el onboarding (después del signup). Necesitás generar un Custom App token en tu admin de Shopify — toma ~5 minutos.',
            },
            {
              q: '¿Puedo cancelar?',
              a: 'No hay suscripción que cancelar. Si no querés usar más LabelFlow, simplemente dejás de comprar packs. Tu cuenta queda con el saldo restante por si volvés.',
            },
            {
              q: '¿Qué métodos de pago aceptan?',
              a: 'MercadoPago (tarjetas de crédito/débito, transferencia, dinero en cuenta). Procesamos los pagos en UYU directamente.',
            },
          ].map((faq, i) => (
            <div
              key={i}
              className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5"
            >
              <h3 className="font-medium mb-2">{faq.q}</h3>
              <p className="text-sm text-zinc-400">{faq.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA final */}
      <section className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h2 className="text-3xl font-bold mb-4">
          Empezá con 10 envíos gratis
        </h2>
        <p className="text-zinc-400 mb-8">
          Probá LabelFlow sin tarjeta. Si te resulta, comprás un pack. Si no, no perdiste nada.
        </p>
        <Link
          href="/signup"
          className="inline-flex items-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 px-8 py-3 rounded-xl font-medium hover:shadow-lg hover:shadow-cyan-500/25 transition-all"
        >
          Crear cuenta gratis
          <ArrowRight className="w-4 h-4" />
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.04] py-8">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-600">
          <p>© 2026 LabelFlow / AutoEnvía · Shopify x DAC Uruguay</p>
          <div className="flex items-center gap-4">
            <Link href="/terminos" className="hover:text-zinc-400 transition-colors">
              Términos
            </Link>
            <Link href="/privacidad" className="hover:text-zinc-400 transition-colors">
              Privacidad
            </Link>
            <Link href="/" className="hover:text-zinc-400 transition-colors">
              Inicio
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
