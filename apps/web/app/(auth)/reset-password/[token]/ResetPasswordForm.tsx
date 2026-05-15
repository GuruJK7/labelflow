'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Zap, ArrowRight, Loader2, Lock, CheckCircle2 } from 'lucide-react';

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    // Client-side checks. The server enforces the same rules — duplicating
    // here is just UX (fast feedback, no extra round-trip).
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Las contraseñas no coinciden.');
      return;
    }

    setLoading(true);

    let res: Response;
    try {
      res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
    } catch {
      setLoading(false);
      setError('No se pudo conectar. Intentá de nuevo en unos segundos.');
      return;
    }

    setLoading(false);

    if (!res.ok) {
      let message = 'El link expiró o no es válido. Pedí uno nuevo.';
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // ignore parse failure — fall back to default message
      }
      setError(message);
      return;
    }

    setDone(true);
    // Wait 2s on the success screen, then redirect to login. Gives the
    // user time to register what happened.
    setTimeout(() => router.push('/login?reset=ok'), 2000);
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

        {done ? (
          <div className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-6 text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-green-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-green-400" />
            </div>
            <h2 className="text-xl font-bold text-white">Contraseña actualizada</h2>
            <p className="text-zinc-400 text-sm">
              Te llevamos al login en un momento…
            </p>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Elegir nueva contraseña</h2>
              <p className="text-zinc-500 text-sm mt-1">
                Elegí una contraseña de al menos 8 caracteres.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm flex items-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0 mt-1.5" />
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label htmlFor="password" className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Nueva contraseña
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all"
                    placeholder="Mínimo 8 caracteres"
                    required
                    autoFocus
                    minLength={8}
                    maxLength={128}
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="confirmPassword"
                  className="block text-xs font-medium text-zinc-400 mb-1.5"
                >
                  Repetí la contraseña
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-white/[0.03] border border-white/[0.08] rounded-xl text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/30 transition-all"
                    placeholder="Repetí la contraseña"
                    required
                    minLength={8}
                    maxLength={128}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !password || !confirmPassword}
                className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white py-3 rounded-xl font-medium text-sm transition-all duration-200 hover:shadow-lg hover:shadow-cyan-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Guardar nueva contraseña
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>

            <div className="mt-8 text-center">
              <Link
                href="/forgot-password"
                className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
              >
                ¿El link no funciona? Pedí uno nuevo
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
