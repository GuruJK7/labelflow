import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'Terminos de Servicio — LabelFlow',
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

        <h1 className="text-3xl font-bold text-white mb-2">Terminos de Servicio</h1>
        <p className="text-zinc-500 text-sm mb-10">
          Ultima actualizacion: 27 de marzo de 2026
        </p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-white mb-3">1. Descripcion del servicio</h2>
            <p>
              LabelFlow es una plataforma de software como servicio (SaaS) que automatiza la
              generacion de etiquetas de envio de DAC Uruguay a partir de pedidos de tiendas
              Shopify. El servicio incluye la creacion automatica de guias, generacion de PDFs de
              etiquetas y notificacion por email a los destinatarios con informacion de rastreo.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">2. Planes y precios</h2>
            <p className="mb-2">
              LabelFlow ofrece los siguientes planes con precios en dolares estadounidenses (USD),
              facturados mensualmente a traves de MercadoPago:
            </p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400">
              <li><strong className="text-zinc-300">Starter</strong> — USD 15/mes — Hasta 100 etiquetas/mes</li>
              <li><strong className="text-zinc-300">Growth</strong> — USD 35/mes — Hasta 500 etiquetas/mes</li>
              <li><strong className="text-zinc-300">Pro</strong> — USD 69/mes — Etiquetas ilimitadas</li>
            </ul>
            <p className="mt-2">
              Los precios pueden ser modificados con un aviso previo de 30 dias naturales. Todos
              los nuevos usuarios reciben un periodo de prueba gratuito de 14 dias.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">3. Condiciones de uso</h2>
            <p>
              Al utilizar LabelFlow, el usuario se compromete a: (a) proporcionar informacion
              veraz y actualizada; (b) mantener la confidencialidad de sus credenciales de acceso;
              (c) no utilizar el servicio para fines ilegales; (d) ser responsable del contenido
              y datos que procesa a traves de la plataforma.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">4. Credenciales de DAC y Shopify</h2>
            <p>
              El usuario es el unico responsable de las credenciales de acceso a su cuenta de DAC
              (dac.com.uy) y de su tienda Shopify. LabelFlow almacena estas credenciales de forma
              cifrada (AES-256-GCM) y las utiliza exclusivamente para la generacion de etiquetas
              de envio en nombre del usuario.
            </p>
            <p className="mt-2">
              El usuario garantiza que tiene autorizacion para utilizar dichas cuentas y que su uso
              a traves de LabelFlow cumple con los terminos de servicio de DAC y Shopify.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">5. Limitacion de responsabilidad</h2>
            <p>LabelFlow no sera responsable por:</p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-2">
              <li>Interrupciones o cambios en el servicio de DAC Uruguay (dac.com.uy)</li>
              <li>Interrupciones o cambios en la API de Shopify</li>
              <li>Errores en la informacion proporcionada por el usuario o sus clientes</li>
              <li>Demoras o perdidas en los envios gestionados por DAC</li>
              <li>Danos indirectos, incidentales o consecuentes derivados del uso del servicio</li>
            </ul>
            <p className="mt-2">
              La responsabilidad maxima de LabelFlow estara limitada al monto pagado por el
              usuario en los ultimos 3 meses de servicio.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">6. Tratamiento de datos de terceros</h2>
            <p>
              El usuario reconoce que LabelFlow procesa datos personales de terceros (destinatarios
              de envios), incluyendo nombre, direccion, telefono y email. El usuario es responsable
              de obtener el consentimiento necesario de los destinatarios para el tratamiento de
              sus datos conforme a la Ley 18.331 de Proteccion de Datos Personales de Uruguay.
            </p>
            <p className="mt-2">
              LabelFlow actua como encargado del tratamiento de estos datos, procesandolos
              unicamente para la finalidad de generacion de etiquetas de envio y notificacion
              al destinatario.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">7. Cancelacion y reembolsos</h2>
            <p>
              El usuario puede cancelar su suscripcion en cualquier momento desde la seccion de
              configuracion. Al cancelar:
            </p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-2">
              <li>El servicio permanecera activo hasta el final del periodo ya pagado</li>
              <li>No se generaran cargos adicionales</li>
              <li>Se otorgara un reembolso proporcional a los dias no utilizados del periodo en curso, siempre que la solicitud se realice dentro de los primeros 7 dias del ciclo de facturacion</li>
            </ul>
            <p className="mt-2">
              Para solicitar un reembolso, contacte a soporte@labelflow.uy. Los reembolsos se
              procesaran a traves de MercadoPago en un plazo de 10 dias habiles.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">8. Modificaciones</h2>
            <p>
              LabelFlow se reserva el derecho de modificar estos terminos con un aviso previo de
              15 dias habiles. Las modificaciones seran notificadas por email al usuario. El uso
              continuado del servicio despues del periodo de aviso constituye aceptacion de los
              nuevos terminos.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">9. Ley aplicable y jurisdiccion</h2>
            <p>
              Estos terminos se rigen por las leyes de la Republica Oriental del Uruguay. Cualquier
              controversia derivada del uso de LabelFlow sera sometida a la jurisdiccion de los
              Juzgados Letrados de Primera Instancia en lo Civil de Montevideo, Uruguay, con renuncia
              expresa a cualquier otro fuero o jurisdiccion que pudiera corresponder.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">10. Defensa del consumidor</h2>
            <p>
              En cumplimiento con la Ley 17.250 de Defensa del Consumidor de Uruguay, el usuario
              tiene derecho a informacion clara y veraz sobre el servicio, a la seguridad en la
              prestacion, y a presentar reclamaciones ante la Direccion General de Comercio del
              Ministerio de Economia y Finanzas.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">11. Contacto</h2>
            <p>
              Para consultas sobre estos terminos o el servicio, contacte a:
            </p>
            <ul className="list-none space-y-1 text-zinc-400 mt-2">
              <li>Email: soporte@labelflow.uy</li>
              <li>Direccion: Montevideo, Uruguay</li>
            </ul>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-white/[0.06] flex items-center justify-between text-xs text-zinc-600">
          <span>LabelFlow</span>
          <Link href="/privacidad" className="text-cyan-400/60 hover:text-cyan-400 transition-colors">
            Politica de Privacidad
          </Link>
        </div>
      </div>
    </div>
  );
}
