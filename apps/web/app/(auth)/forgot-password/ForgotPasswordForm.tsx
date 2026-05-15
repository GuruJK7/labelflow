'use client';

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { Zap, ArrowRight, Loader2, Mail, CheckCircle2 } from 'lucide-react';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  // We deliberately don't differentiate "email sent" vs "email not found".
  // The success screen is the same either way — see the route comment for
  // the security rationale.
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase() }),
      });
    } catch {
      // Network errors are ignored — the success screen still shows, so an
      // attacker can't probe by looking at error UI.
    }
    setSubmitted(true);
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-white text-lg">
              Label<span className="text-cyan-400">Flow</span>
            </span>
          </Link>
        </div>

        {submitted ? (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-6 text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-cyan-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-cyan-400" />
            </div>
            <h2 className="text-xl font-bold text-white">Revisá tu email</h2>
            <p className="text-zinc-400 text-sm">
              Si <strong className="text-zinc-200">{email}</strong> está registrado en LabelFlow, te
              enviamos un link para elegir una nueva contraseña. El link expira en 1 hora.
            </p>
            <p className="text-zinc-600 text-xs">
              ¿No te llegó? Revisá la carpeta de spam o pedí otro en unos minutos.
            </p>
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 text-cyan-400 hover:text-cyan-300 text-sm font-medium mt-4 transition-colors"
            >
              Volver al login
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Recuperar contraseña</h2>
              <p className="text-zinc-500 text-sm mt-1">
                Ingresá tu email y te enviamos un link para elegir una nueva.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all"
                    placeholder="tu@email.com"
                    required
                    autoFocus
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !email}
                className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white py-3 rounded-xl font-medium text-sm transition-all duration-200 hover:shadow-lg hover:shadow-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Enviar link de recuperación
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>

            <div className="mt-8 text-center">
              <p className="text-zinc-500 text-sm">
                ¿Te acordaste?{' '}
                <Link
                  href="/login"
                  className="text-cyan-400 hover:text-cyan-300 font-medium transition-colors"
                >
                  Iniciar sesión
                </Link>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
