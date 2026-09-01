'use client';

/**
 * Formulario de alta pública (/signup).
 *
 *   - Google OAuth como primer CTA si el server tiene AUTH_GOOGLE_ID/SECRET
 *     (`googleEnabled`); si no, el form de email/contraseña es el único camino.
 *   - Validación en cliente ANTES de pegarle al server (nombre, email,
 *     contraseña >= 8, términos). El server vuelve a validar todo (zod);
 *     cualquier error del server (403 bandera apagada, 409 email repetido,
 *     429 rate limit, 400) se muestra tal cual arriba del form.
 *   - Honeypot: el input `website` está fuera de la vista y del tab order.
 *     Un humano nunca lo completa; un bot que rellena todo sí. El server
 *     responde 200 sin crear nada si viene con valor (D25).
 *   - Atribución de referidos: se captura ?ref=<code> y se le pide al server
 *     que firme una cookie HMAC (POST /api/referrals/track). El handler de
 *     signup SOLO confía en esa cookie e ignora el `referralCode` del body.
 *   - Al 201 se navega a /verify-email?email=<email>, que explica el paso
 *     siguiente y permite reenviar el mail.
 *
 * Copy: el bono de 10 envíos coincide con `Tenant.shipmentCredits
 * @default(10)` del schema. No se promete un valor en pesos: ese número
 * lo tiene que confirmar el dueño (ver PENDIENTES.md).
 */

import { Suspense, useEffect, useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Zap, Gift, Check, ArrowRight, Loader2, MessageCircle } from 'lucide-react';
import { GoogleSignInButton, OrDivider } from '../_components/GoogleSignInButton';
import { track } from '@/lib/analytics';

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INPUT_CLASS =
  'w-full px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all';

export function SignupForm({
  googleEnabled,
  whatsappUrl,
}: {
  googleEnabled: boolean;
  whatsappUrl: string;
}) {
  return (
    <Suspense fallback={null}>
      <SignupContent googleEnabled={googleEnabled} whatsappUrl={whatsappUrl} />
    </Suspense>
  );
}

function SignupContent({
  googleEnabled,
  whatsappUrl,
}: {
  googleEnabled: boolean;
  whatsappUrl: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refCode, setRefCode] = useState<string | null>(null);

  useEffect(() => {
    const ref = searchParams.get('ref');
    if (ref && /^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/.test(ref)) {
      setRefCode(ref);
      fetch('/api/referrals/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ref }),
      }).catch(() => {});
    }
  }, [searchParams]);

  /** Misma normalización que hace el server: sin espacios en los bordes y en minúsculas. */
  const emailNormalizado = email.trim().toLowerCase();

  function validar(): string | null {
    if (!name.trim()) return 'Decinos tu nombre.';
    if (!EMAIL_RE.test(emailNormalizado)) return 'Ingresá un email válido.';
    if (password.length < MIN_PASSWORD) {
      return `La contraseña tiene que tener al menos ${MIN_PASSWORD} caracteres.`;
    }
    if (!tosAccepted) return 'Tenés que aceptar los Términos y la Política de Privacidad.';
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    const problema = validar();
    if (problema) {
      setError(problema);
      return;
    }

    setLoading(true);
    track('signup_method_selected', { method: 'email' });

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: emailNormalizado,
          password,
          tosAccepted,
          referralCode: refCode,
          website,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as { error?: string };

      if (!res.ok) {
        setError(data.error ?? 'No pudimos crear tu cuenta. Probá de nuevo en un momento.');
        setLoading(false);
        return;
      }

      router.push(`/verify-email?email=${encodeURIComponent(emailNormalizado)}`);
    } catch {
      setError('Error de conexión. Revisá tu internet y probá de nuevo.');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] py-12 px-4 relative overflow-hidden">
      <div
        className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-cyan-500/[0.06] rounded-full blur-[120px]"
        aria-hidden="true"
      />

      <div className="w-full max-w-md relative">
        {/* Logo — mismo bloque que el login */}
        <div className="text-center mb-6">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <div className="w-9 h-9 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-white text-lg tracking-tight">
              Label<span className="text-cyan-400">Flow</span>
            </span>
          </Link>
        </div>

        {/* Bono de bienvenida */}
        <div className="relative mb-6 overflow-hidden rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/[0.08] via-emerald-500/[0.04] to-transparent p-5 shadow-xl shadow-cyan-500/10">
          <div className="relative flex items-start gap-3">
            <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-400 flex items-center justify-center shadow-lg shadow-cyan-500/30">
              <Gift className="w-5 h-5 text-zinc-950" strokeWidth={2.5} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-300 mb-0.5">
                Bono de bienvenida
              </div>
              <h2 className="text-lg font-bold text-white leading-tight">
                10 envíos gratis para empezar
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                Sin tarjeta. Conectás tu tienda Shopify y tu cuenta DAC, y despachás.
              </p>
            </div>
          </div>
          {refCode && (
            <div className="relative mt-4 pt-4 border-t border-cyan-400/15 text-xs">
              <span className="inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-2.5 py-1 rounded-full font-medium">
                Te invitó <strong className="font-bold">{refCode}</strong> · +10 envíos extra
              </span>
            </div>
          )}
        </div>

        {/* Form */}
        <div className="bg-zinc-900/40 backdrop-blur-sm border border-white/[0.06] rounded-2xl p-6 sm:p-7">
          <div className="mb-5">
            <h1 className="text-xl font-bold text-white">Creá tu cuenta</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Te mandamos un mail para confirmar la dirección y listo.
            </p>
          </div>

          {googleEnabled && (
            <>
              <GoogleSignInButton callbackUrl="/onboarding" label="Registrarme con Google" />
              <OrDivider label="o con email" />
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
            {error && (
              <div
                role="alert"
                className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2.5 rounded-lg text-sm flex items-center gap-2"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
                {error}
              </div>
            )}

            <div>
              <label htmlFor="name" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Nombre
              </label>
              <input
                id="name"
                name="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={INPUT_CLASS}
                placeholder="Tu nombre o el de tu tienda"
                autoComplete="name"
                maxLength={100}
                required
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={INPUT_CLASS}
                placeholder="tu@email.com"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Contraseña
              </label>
              <input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT_CLASS}
                placeholder={`Mínimo ${MIN_PASSWORD} caracteres`}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                maxLength={100}
                required
              />
              <p className="text-[11px] text-zinc-600 mt-1.5">
                Mínimo {MIN_PASSWORD} caracteres. Cualquier combinación sirve.
              </p>
            </div>

            {/* Honeypot: fuera de la vista y del tab order. No usar `hidden`
                ni display:none porque algunos bots los saltean. */}
            <div
              aria-hidden="true"
              className="absolute -left-[9999px] top-auto w-px h-px overflow-hidden"
            >
              <label htmlFor="website">Sitio web</label>
              <input
                id="website"
                name="website"
                type="text"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
              />
            </div>

            <div className="flex items-start gap-2.5 pt-1">
              <input
                id="tos"
                name="tos"
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-white/[0.15] bg-zinc-800/50 text-cyan-600 focus:ring-cyan-500/40 focus:ring-offset-0 cursor-pointer"
              />
              <label htmlFor="tos" className="text-xs text-zinc-400 cursor-pointer leading-snug">
                Acepto los{' '}
                <Link
                  href="/terminos"
                  target="_blank"
                  className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                >
                  Términos de Servicio
                </Link>{' '}
                y la{' '}
                <Link
                  href="/privacidad"
                  target="_blank"
                  className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                >
                  Política de Privacidad
                </Link>
              </label>
            </div>

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full flex items-center justify-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-cyan-500/20"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creando tu cuenta…
                </>
              ) : (
                <>
                  Crear cuenta gratis
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 mt-5 text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <Check className="w-3 h-3 text-emerald-400" />
              Sin tarjeta
            </span>
            <span className="inline-flex items-center gap-1">
              <Check className="w-3 h-3 text-emerald-400" />
              10 envíos gratis
            </span>
            <span className="inline-flex items-center gap-1">
              <Check className="w-3 h-3 text-emerald-400" />
              Cancelás cuando quieras
            </span>
          </div>
        </div>

        {/* Alta asistida */}
        <div className="mt-5 text-center">
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <MessageCircle className="w-3.5 h-3.5 text-cyan-400" />
            ¿Preferís que te lo implementemos nosotros? Escribinos
          </a>
        </div>

        <div className="mt-4 text-center">
          <p className="text-zinc-500 text-sm">
            ¿Ya tenés cuenta?{' '}
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
