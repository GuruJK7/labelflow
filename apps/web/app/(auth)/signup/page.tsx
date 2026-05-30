import Link from 'next/link';
import { Zap, Lock, ArrowRight, ShieldCheck, HeadphonesIcon } from 'lucide-react';

export const metadata = {
  title: 'Acceso por invitación — LabelFlow Enterprise',
  description:
    'LabelFlow opera bajo modelo enterprise. Las cuentas se provisionan tras la firma del acuerdo de servicios.',
};

const WHATSAPP_URL =
  'https://wa.me/59898943949?text=' +
  encodeURIComponent(
    'Hola, quiero coordinar una llamada para evaluar la implementación de LabelFlow en mi operación.',
  );

export default function SignupRestrictedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] py-12 px-4 relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-cyan-500/[0.06] rounded-full blur-[120px]"
      />

      <div className="w-full max-w-md relative">
        <div className="text-center mb-6">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <div className="w-9 h-9 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-bold text-white text-lg tracking-tight">
                Label<span className="text-cyan-400">Flow</span>
              </span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-medium">
                Enterprise
              </span>
            </div>
          </Link>
        </div>

        <div className="bg-zinc-900/40 backdrop-blur-sm border border-white/[0.06] rounded-2xl p-8 text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-cyan-500/15 to-emerald-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-5">
            <Lock className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold text-white mb-2">Acceso por invitación</h1>
          <p className="text-sm text-zinc-400 leading-relaxed mb-6">
            LabelFlow opera bajo modelo enterprise con cupos limitados. Las cuentas se
            provisionan después de la llamada de evaluación y la firma del acuerdo de
            servicios.
          </p>

          <div className="space-y-3 mb-6 text-left">
            {[
              { icon: <ShieldCheck className="w-4 h-4" />, text: 'Implementación llave en mano' },
              { icon: <HeadphonesIcon className="w-4 h-4" />, text: 'Operación gestionada por nuestro equipo' },
              { icon: <ArrowRight className="w-4 h-4" />, text: 'Tiempo a producción: 5 a 10 días' },
            ].map((p) => (
              <div
                key={p.text}
                className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.05] rounded-lg px-3.5 py-2.5"
              >
                <span className="text-cyan-400 flex-shrink-0">{p.icon}</span>
                <span className="text-xs text-zinc-300">{p.text}</span>
              </div>
            ))}
          </div>

          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center justify-center gap-2 w-full bg-cyan-500 hover:bg-cyan-400 text-zinc-950 py-3 rounded-xl font-semibold text-sm transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40"
          >
            Solicitar evaluación por WhatsApp
            <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
          </a>
        </div>

        <div className="mt-6 text-center">
          <p className="text-zinc-500 text-sm">
            ¿Ya sos cliente?{' '}
            <Link
              href="/login"
              className="text-cyan-400 hover:text-cyan-300 font-medium transition-colors"
            >
              Iniciar sesión
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
