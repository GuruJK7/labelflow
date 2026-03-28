import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'Politica de Privacidad — LabelFlow',
};

export default function PrivacidadPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-zinc-500 hover:text-white text-sm mb-10 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Volver al inicio
        </Link>

        <h1 className="text-3xl font-bold text-white mb-2">Politica de Privacidad</h1>
        <p className="text-zinc-500 text-sm mb-10">
          Ultima actualizacion: 27 de marzo de 2026
        </p>

        <div className="space-y-8 text-sm leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-white mb-3">1. Responsable del tratamiento</h2>
            <p>
              LabelFlow, con domicilio en Montevideo, Uruguay, es el responsable del tratamiento
              de los datos personales recabados a traves de esta plataforma, en cumplimiento con
              la Ley 18.331 de Proteccion de Datos Personales y Accion de Habeas Data y su
              Decreto Reglamentario 414/009.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">2. Datos que recopilamos</h2>
            <p className="mb-3">Recopilamos las siguientes categorias de datos personales:</p>

            <h3 className="text-sm font-semibold text-zinc-200 mb-1">Datos del usuario (titular de cuenta)</h3>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mb-3">
              <li>Nombre completo y email</li>
              <li>Contrasena (almacenada con hash bcrypt, nunca en texto plano)</li>
              <li>Direccion IP al momento del registro</li>
              <li>Fecha y hora de aceptacion de terminos</li>
              <li>Credenciales de Shopify y DAC (cifradas con AES-256-GCM)</li>
            </ul>

            <h3 className="text-sm font-semibold text-zinc-200 mb-1">Datos de terceros (destinatarios de envios)</h3>
            <ul className="list-disc list-inside space-y-1 text-zinc-400">
              <li>Nombre completo</li>
              <li>Direccion de envio (calle, ciudad, departamento)</li>
              <li>Telefono de contacto</li>
              <li>Email (para notificacion de envio)</li>
              <li>Monto del pedido en UYU</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">3. Finalidad del tratamiento</h2>
            <p>Los datos personales son tratados exclusivamente para:</p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-2">
              <li>Creacion de etiquetas de envio en DAC Uruguay</li>
              <li>Notificacion al destinatario con numero de guia y link de rastreo</li>
              <li>Gestion de la cuenta del usuario y facturacion</li>
              <li>Generacion de reportes y estadisticas de uso para el titular</li>
              <li>Cumplimiento de obligaciones legales</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">4. Base legal del tratamiento</h2>
            <p>
              El tratamiento de datos se fundamenta en: (a) el consentimiento informado del
              usuario al aceptar estos terminos; (b) la ejecucion del contrato de prestacion de
              servicios; (c) el interes legitimo en la seguridad y mejora del servicio; y (d) el
              cumplimiento de obligaciones legales aplicables.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">5. Almacenamiento y seguridad</h2>
            <p className="mb-2">Los datos son almacenados en:</p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400">
              <li><strong className="text-zinc-300">Base de datos:</strong> Supabase (PostgreSQL), alojado en AWS (region us-east-1)</li>
              <li><strong className="text-zinc-300">Cache y colas:</strong> Upstash (Redis), infraestructura global</li>
              <li><strong className="text-zinc-300">Servidor de aplicacion:</strong> Render / Vercel</li>
            </ul>
            <p className="mt-3">Medidas de seguridad implementadas:</p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-1">
              <li>Cifrado de credenciales sensibles con AES-256-GCM</li>
              <li>Contrasenas hasheadas con bcrypt (factor 12)</li>
              <li>Comunicaciones cifradas con TLS 1.3</li>
              <li>Acceso a base de datos restringido por IP y credenciales rotadas</li>
              <li>Autenticacion con tokens JWT firmados</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">6. Periodo de retencion</h2>
            <p>
              Los datos personales se conservaran por un periodo maximo de 24 meses desde la
              ultima actividad del usuario o la finalizacion de la relacion contractual. Transcurrido
              dicho plazo, los datos seran eliminados de forma automatica y definitiva.
            </p>
            <p className="mt-2">
              Los registros de etiquetas y envios se conservaran por el periodo legalmente
              requerido para fines de facturacion y auditoria (5 anos conforme a la normativa
              tributaria vigente).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">7. Derechos ARCO</h2>
            <p>
              De conformidad con la Ley 18.331, el titular de los datos tiene derecho a:
            </p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-2">
              <li><strong className="text-zinc-300">Acceso:</strong> Conocer que datos personales tenemos almacenados</li>
              <li><strong className="text-zinc-300">Rectificacion:</strong> Solicitar la correccion de datos inexactos o incompletos</li>
              <li><strong className="text-zinc-300">Cancelacion:</strong> Solicitar la eliminacion de sus datos personales</li>
              <li><strong className="text-zinc-300">Oposicion:</strong> Oponerse al tratamiento de sus datos para fines especificos</li>
            </ul>
            <p className="mt-3">
              Para ejercer estos derechos, envie un email a <strong className="text-cyan-400">soporte@labelflow.uy</strong> indicando
              su nombre, email de cuenta y el derecho que desea ejercer. La solicitud sera
              procesada dentro de los 5 dias habiles siguientes, conforme al articulo 14 de la
              Ley 18.331.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">8. Transferencia a terceros</h2>
            <p>
              Los datos personales pueden ser compartidos con los siguientes terceros, estrictamente
              para las finalidades descritas:
            </p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-2">
              <li><strong className="text-zinc-300">DAC Uruguay (dac.com.uy):</strong> Datos del destinatario para la creacion de guias de envio</li>
              <li><strong className="text-zinc-300">MercadoPago:</strong> Datos de facturacion del titular para el cobro de suscripciones</li>
              <li><strong className="text-zinc-300">Shopify:</strong> Conexion API para la obtencion de datos de pedidos (iniciada por el usuario)</li>
            </ul>
            <p className="mt-2">
              No vendemos, alquilamos ni compartimos datos personales con terceros para fines
              de marketing o publicidad.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">9. Transferencia internacional de datos</h2>
            <p>
              Los datos son almacenados en servidores ubicados fuera de Uruguay (AWS, Estados Unidos).
              Esta transferencia se realiza con las garantias adecuadas de seguridad descritas en
              la seccion 5 y en cumplimiento con el articulo 23 de la Ley 18.331.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">10. Cookies</h2>
            <p>
              LabelFlow utiliza unicamente cookies esenciales para el funcionamiento de la
              plataforma (sesion de usuario, token CSRF). No utilizamos cookies de rastreo,
              analiticas o publicitarias.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">11. Organismo de control</h2>
            <p>
              La Unidad Reguladora y de Control de Datos Personales (URCDP) es el organismo
              encargado de velar por el cumplimiento de la Ley 18.331. El titular de datos puede
              presentar denuncias o consultas ante:
            </p>
            <ul className="list-none space-y-1 text-zinc-400 mt-2">
              <li>Unidad Reguladora y de Control de Datos Personales (URCDP)</li>
              <li>Andes 1365, Piso 8, Montevideo, Uruguay</li>
              <li>Telefono: (598) 2901 2929 int. 1352</li>
              <li>Web: www.gub.uy/urcdp</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">12. Contacto</h2>
            <p>
              Para consultas sobre esta politica de privacidad o el tratamiento de sus datos:
            </p>
            <ul className="list-none space-y-1 text-zinc-400 mt-2">
              <li>Email: soporte@labelflow.uy</li>
              <li>Direccion: Montevideo, Uruguay</li>
            </ul>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-white/[0.06] flex items-center justify-between text-xs text-zinc-600">
          <span>LabelFlow</span>
          <Link href="/terminos" className="text-cyan-400/60 hover:text-cyan-400 transition-colors">
            Terminos de Servicio
          </Link>
        </div>
      </div>
    </div>
  );
}
