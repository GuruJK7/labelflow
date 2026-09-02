import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { whatsappUrl, WHATSAPP_LEGIBLE } from '@/lib/contacto';
import { TRIAL_SHIPMENTS } from '@/lib/trial';
import { SELF_SERVE_PACK_SHIPMENTS } from '@/lib/credit-packs';
import { PRICING_TIERS, formatUsdUnitMilli, unitPriceUsdMilliFor } from '@/lib/pricing';

/**
 * Los precios del documento salen de la MISMA tabla que cobra el checkout.
 * Escritos a mano se desactualizan en silencio, que es exactamente lo que pasó
 * con los planes mensuales de USD 15/35/69 que este documento describió hasta
 * el 2026-09-02: un producto que la plataforma nunca vendió.
 */
const LIST_PRICE_USD = formatUsdUnitMilli(PRICING_TIERS[0].unitPriceUsdMilli);
const LOWEST_PRICE_USD = formatUsdUnitMilli(
  unitPriceUsdMilliFor(SELF_SERVE_PACK_SHIPMENTS[SELF_SERVE_PACK_SHIPMENTS.length - 1]),
);
const WHATSAPP_URL = whatsappUrl('Hola, tengo una consulta sobre los Términos de AutoEnvía.');

export const metadata = {
  title: 'Términos de Servicio — AutoEnvía',
};

export default function TerminosPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-zinc-500 hover:text-white text-sm mb-10 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Volver al inicio
        </Link>

        <h1 className="text-3xl font-bold text-white mb-2">Términos de Servicio</h1>
        <p className="text-zinc-500 text-sm mb-10">
          Última actualización: 2 de setiembre de 2026
        </p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-white mb-3">1. Descripción del servicio</h2>
            <p>
              AutoEnvía, servicio operado por LabelFlow SAS, es una plataforma de software como
              servicio (SaaS) que automatiza la generación de etiquetas de envío de DAC Uruguay a partir de pedidos de tiendas
              Shopify. El servicio incluye la creación automática de guías, generación de PDFs de
              etiquetas y notificación por email a los destinatarios con información de rastreo.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">2. Precios y forma de pago</h2>
            <p className="mb-2">
              AutoEnvía <strong className="text-zinc-300">no cobra una mensualidad</strong>. El
              usuario compra packs de envíos con un pago único, y se descuenta un envío por cada
              guía emitida con éxito. Los envíos comprados no vencen.
            </p>
            <p className="mb-2">
              El precio de lista está denominado en dólares estadounidenses (USD) por envío y baja
              según el volumen mensual: desde {LIST_PRICE_USD} USD por envío hasta{' '}
              {LOWEST_PRICE_USD} USD en el escalón más alto disponible en autoservicio. El
              tarifario vigente, con el precio de cada escalón, está publicado en{' '}
              <Link href="/#precios" className="text-cyan-400 hover:underline">la página de precios</Link>.
            </p>
            <p className="mb-2">
              El cobro se realiza en pesos uruguayos a través de MercadoPago, convertido desde el
              precio de lista en dólares al tipo de cambio de referencia que AutoEnvía publica en
              su tarifario. No es la cotización del día y puede cambiar; el monto exacto en pesos
              se muestra antes de confirmar el pago.
            </p>
            <p>
              Al crear la cuenta, el usuario recibe {TRIAL_SHIPMENTS} envíos de prueba sin costo y
              sin necesidad de registrar una tarjeta. Los precios pueden ser modificados con un
              aviso previo de 30 días naturales; la modificación no afecta a los envíos ya
              comprados.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">3. Condiciones de uso</h2>
            <p>
              Al utilizar AutoEnvía, el usuario se compromete a: (a) proporcionar información
              veraz y actualizada; (b) mantener la confidencialidad de sus credenciales de acceso;
              (c) no utilizar el servicio para fines ilegales; (d) ser responsable del contenido
              y datos que procesa a través de la plataforma.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">4. Credenciales de DAC y Shopify</h2>
            <p>
              El usuario es el único responsable de las credenciales de acceso a su cuenta de DAC
              (dac.com.uy) y de su tienda Shopify. AutoEnvía almacena estas credenciales de forma
              cifrada (AES-256-GCM) y las utiliza exclusivamente para la generación de etiquetas
              de envío en nombre del usuario.
            </p>
            <p className="mt-2">
              El usuario garantiza que tiene autorizacion para utilizar dichas cuentas y que su uso
              a través de AutoEnvía cumple con los términos de servicio de DAC y Shopify.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">5. Limitacion de responsabilidad</h2>
            <p>LabelFlow SAS no sera responsable por:</p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-2">
              <li>Interrupciones o cambios en el servicio de DAC Uruguay (dac.com.uy)</li>
              <li>Interrupciones o cambios en la API de Shopify</li>
              <li>Errores en la información proporcionada por el usuario o sus clientes</li>
              <li>Demoras o pérdidas en los envíos gestionados por DAC</li>
              <li>Danos indirectos, incidentales o consecuentes derivados del uso del servicio</li>
            </ul>
            <p className="mt-2">
              La responsabilidad maxima de LabelFlow SAS estara limitada al monto pagado por el
              usuario en los ultimos 3 meses de servicio.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">6. Tratamiento de datos de terceros</h2>
            <p>
              El usuario reconoce que LabelFlow SAS procesa datos personales de terceros (destinatarios
              de envíos), incluyendo nombre, dirección, teléfono y email. El usuario es responsable
              de obtener el consentimiento necesario de los destinatarios para el tratamiento de
              sus datos conforme a la Ley 18.331 de Protección de Datos Personales de Uruguay.
            </p>
            <p className="mt-2">
              LabelFlow SAS actua como encargado del tratamiento de estos datos, procesandolos
              únicamente para la finalidad de generación de etiquetas de envío y notificación
              al destinatario.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">7. Cancelación y reembolsos</h2>
            <p>
              No hay suscripción que cancelar ni cargos automáticos: cada compra es un pago único.
              El usuario puede dejar de usar el servicio cuando quiera, sin aviso previo y sin
              penalidad. Al dejar de usarlo:
            </p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-2">
              <li>No se generan cargos adicionales de ningún tipo</li>
              <li>Los envíos ya comprados y no utilizados permanecen disponibles en la cuenta, sin fecha de vencimiento</li>
              <li>El usuario puede solicitar el reembolso de los envíos comprados y no utilizados dentro de los 30 días corridos desde la compra</li>
            </ul>
            <p className="mt-2">
              Los envíos ya consumidos no se reembolsan, porque corresponden a guías efectivamente
              emitidas ante DAC. Para solicitar un reembolso, escribinos por los canales de la
              cláusula 11. Los reembolsos se procesan por el mismo medio de pago en un plazo de 10
              días hábiles.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">8. Modificaciones</h2>
            <p>
              LabelFlow SAS se reserva el derecho de modificar estos términos con un aviso previo de
              15 días hábiles. Las modificaciones serán notificadas por email al usuario. El uso
              continuado del servicio después del período de aviso constituye aceptación de los
              nuevos términos.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">9. Ley aplicable y jurisdiccion</h2>
            <p>
              Estos términos se rigen por las leyes de la República Oriental del Uruguay. Cualquier
              controversia derivada del uso de AutoEnvía sera sometida a la jurisdiccion de los
              Juzgados Letrados de Primera Instancia en lo Civil de Montevideo, Uruguay, con renuncia
              expresa a cualquier otro fuero o jurisdiccion que pudiera corresponder.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">10. Defensa del consumidor</h2>
            <p>
              En cumplimiento con la Ley 17.250 de Defensa del Consumidor de Uruguay, el usuario
              tiene derecho a información clara y veraz sobre el servicio, a la seguridad en la
              prestación, y a presentar reclamaciones ante la Dirección General de Comercio del
              Ministerio de Economia y Finanzas.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">11. Contacto</h2>
            <p>
              Para consultas sobre estos términos o el servicio, y para las solicitudes previstas
              en la cláusula 7, el canal de atención es:
            </p>
            <ul className="list-none space-y-1 text-zinc-400 mt-2">
              <li>
                WhatsApp:{' '}
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
                  {WHATSAPP_LEGIBLE}
                </a>
              </li>
              <li>Dirección: Montevideo, Uruguay</li>
            </ul>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-white/[0.06] flex items-center justify-between text-xs text-zinc-600">
          <span>AutoEnvía · por LabelFlow SAS</span>
          <Link href="/privacidad" className="text-cyan-400/60 hover:text-cyan-400 transition-colors">
            Política de Privacidad
          </Link>
        </div>
      </div>
    </div>
  );
}
