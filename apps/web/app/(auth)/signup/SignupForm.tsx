'use client';

/**
 * Signup page — conversion-optimized layout (2026-04-30 redesign).
 *
 * Strategy:
 *   - One-click Google OAuth as PRIMARY CTA above the form. SaaS A/B tests
 *     consistently show 30-50% lift on signup completion when the user can
 *     skip the email-password-confirm path.
 *   - Visible value anchor: "10 envíos GRATIS · valor $200 UYU". Anchoring
 *     the gift to a real money figure makes the offer feel concrete instead
 *     of an abstract perk that the user discounts mentally.
 *   - Risk-reversal microcopy directly under the CTA: "Sin tarjeta · Sin
 *     suscripción · Sin caducidad". Removes the "what's the catch" reflex.
 *   - Email/password form preserved for users who don't want OAuth, but
 *     visually demoted (under the OR divider, smaller buttons).
 *   - Referral attribution preserved exactly: cookie-based, server-side,
 *     equally applied to both Google and email/password paths (see
 *     apps/web/lib/auth.ts:signIn callback).
 */

import { Suspense, useEffect, useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, Gift, Check, ArrowRight, Loader2 } from 'lucide-react';
import { GoogleSignInButton, OrDivider } from '../_components/GoogleSignInButton';

export function SignupForm({ googleEnabled }: { googleEnabled: boolean }) {
  return (
    <Suspense fallback={null}>
      <SignupContent googleEnabled={googleEnabled} />
    </Suspense>
  );
}

function SignupContent({ googleEnabled }: { googleEnabled: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refCode, setRefCode] = useState<string | null>(null);

  // Capturar ?ref=<code> y pedirle al server que firme una cookie HMAC
  // (httpOnly + secure + samesite=lax). El handler de /api/auth/signup
  // SÓLO confía en esa cookie — ignora cualquier `referralCode` en el
  // body. Esto evita que un atacante POSTée códigos forjados directamente.
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email: email.toLowerCase(),
          password,
          tosAccepted,
          referralCode: refCode,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Error al registrarse');
        setLoading(false);
        return;
      }

      router.push(`/verify-email?email=${encodeURIComponent(email.toLowerCase())}`);
    } catch {
      setError('Error de conexion');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] py-12 px-4">
      {/* Ambient glow */}
      <div
        className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-cyan-500/[0.06] rounded-full blur-[120px]"
        aria-hidden="true"
      />

      <div className="w-full max-w-md relative">
        {/* Logo */}
        <div className="text-center mb-6">
          <Link href="/" className="inline-block">
            <h1 className="text-2xl font-bold text-white">
              Label<span className="text-cyan-400">Flow</span>
            </h1>
          </Link>
        </div>

        {/* The Hero Offer Card — anchored, animated, unmissable */}
        <div className="relative mb-6 overflow-hidden rounded-2xl border border-cyan-400/30 bg-gradient-to-br from-cyan-500/[0.08] via-emerald-500/[0.04] to-transparent p-5 shadow-xl shadow-cyan-500/10">
          {/* Subtle pulse glow */}
          <div
            className="pointer-events-none absolute -top-12 -right-12 w-48 h-48 bg-cyan-400/15 rounded-full blur-3xl animate-pulse"
            aria-hidden="true"
          />
          <div className="relative flex items-start gap-3">
            <div className="flex-shrink-0 w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-400 flex items-center justify-center shadow-lg shadow-cyan-500/30">
              <Gift className="w-5 h-5 text-zinc-950" strokeWidth={2.5} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-emerald-300 mb-0.5">
                <Sparkles className="w-3 h-3" />
                Bono de bienvenida
              </div>
              <h2 className="text-lg font-bold text-white leading-tight">
                10 envíos GRATIS al registrarte
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                Valor <span className="text-zinc-200 font-semibold line-through">$200 UYU</span>{' '}
                — sin tarjeta, sin suscripción.
              </p>
            </div>
          </div>
          {refCode && (
            <div className="relative mt-4 pt-4 border-t border-cyan-400/15 text-xs">
              <span className="inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-2.5 py-1 rounded-full font-medium">
                <Sparkles className="w-3 h-3" />
                Te invitó <strong className="font-bold">{refCode}</strong> · +10
                envíos extra
              </span>
            </div>
          )}
        </div>

        {/* Auth surface */}
        <div className="bg-zinc-900/40 backdrop-blur-sm border border-white/[0.06] rounded-2xl p-6 sm:p-7">
          <div className="mb-5">
            <h3 className="text-base font-semibold text-white">
              Comenzá ya y reclamá tus 10 envíos
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Tu cuenta queda lista en 30 segundos.
            </p>
          </div>

          {/* Primary CTA: Google — rendered ONLY if AUTH_GOOGLE_ID +
              AUTH_GOOGLE_SECRET are configured on the server. Without those
              env vars NextAuth's GoogleProvider isn't loaded, and clicking
              the button bounces the user to /login (NextAuth's default
              `pages.signIn` fallback). Hiding the button when not configured
              keeps the customer-facing UX consistent — they only see paths
              that actually work. */}
          {googleEnabled && (
            <>
              <GoogleSignInButton
                callbackUrl="/onboarding"
                label="Registrarme con Google"
              />
              <OrDivider label="o con email" />
            </>
          )}

          {/* Email/password form — secondary if Google is enabled,
              otherwise it's the only path. */}
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2.5 rounded-lg text-sm flex items-center gap-2">
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
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all"
                placeholder="Tu nombre"
                required
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all"
                placeholder="tu@email.com"
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all"
                placeholder="Mínimo 8 caracteres"
                minLength={8}
                required
              />
            </div>

            <div className="flex items-start gap-2.5 pt-1">
              <input
                id="tos"
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
                  Términos
                </Link>{' '}
                y la{' '}
                <Link
                  href="/privacidad"
                  target="_blank"
                  className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
                >
                  Privacidad
                </Link>
              </label>
            </div>

            <button
              type="submit"
              disabled={loading || !tosAccepted}
              className="w-full flex items-center justify-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-950 py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-cyan-500/20"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  Crear cuenta y reclamar mis 10 envíos
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Risk reversal row */}
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 mt-5 text-[11px] text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <Check className="w-3 h-3 text-emerald-400" />
              Sin tarjeta
            </span>
            <span className="inline-flex items-center gap-1">
              <Check className="w-3 h-3 text-emerald-400" />
              Sin suscripción
            </span>
            <span className="inline-flex items-center gap-1">
              <Check className="w-3 h-3 text-emerald-400" />
              Cancelás cuando quieras
            </span>
          </div>
        </div>

        {/* Returning user link */}
        <div className="mt-6 text-center">
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
