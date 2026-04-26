'use client';

import { Suspense, useEffect, useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupContent />
    </Suspense>
  );
}

function SignupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refCode, setRefCode] = useState<string | null>(null);

  // Capturar ?ref=<code> y persistir como cookie firmada (server-side
  // genera la cookie en /api/auth/signup; acá solo guardamos el código
  // para enviarlo en el body del POST). Si el usuario llegó sin ?ref pero
  // tiene la cookie de una visita previa, el server la lee igual.
  useEffect(() => {
    const ref = searchParams.get('ref');
    if (ref && /^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/.test(ref)) {
      setRefCode(ref);
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

      router.push('/login?registered=true');
    } catch {
      setError('Error de conexion');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a]">
      <div className="w-full max-w-md px-4">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">
            Label<span className="text-cyan-400">Flow</span>
          </h1>
          <p className="text-zinc-500 mt-2">Crea tu cuenta gratis · 10 envíos de regalo</p>
          {refCode && (
            <p className="mt-2 inline-block bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-xs px-3 py-1 rounded-full">
              Te invitó <strong>{refCode}</strong>
            </p>
          )}
        </div>

        <div className="bg-zinc-900/50 border border-white/[0.08] rounded-xl p-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="name" className="block text-sm font-medium text-zinc-400 mb-1.5">
                Nombre
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 transition-colors"
                placeholder="Tu nombre"
                required
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-zinc-400 mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 transition-colors"
                placeholder="tu@email.com"
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-zinc-400 mb-1.5">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 transition-colors"
                placeholder="Minimo 8 caracteres"
                minLength={8}
                required
              />
            </div>

            <div className="flex items-start gap-3">
              <input
                id="tos"
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-white/[0.15] bg-zinc-800/50 text-cyan-600 focus:ring-cyan-500/40 focus:ring-offset-0 cursor-pointer"
              />
              <label htmlFor="tos" className="text-sm text-zinc-400 cursor-pointer leading-snug">
                Acepto los{' '}
                <Link href="/terminos" target="_blank" className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">
                  Terminos de Servicio
                </Link>{' '}
                y la{' '}
                <Link href="/privacidad" target="_blank" className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2">
                  Politica de Privacidad
                </Link>
              </label>
            </div>

            <button
              type="submit"
              disabled={loading || !tosAccepted}
              className="w-full bg-cyan-600 hover:bg-cyan-500 text-white py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Creando cuenta...' : 'Crear cuenta'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-zinc-500 text-sm">
              Ya tenes cuenta?{' '}
              <Link href="/login" className="text-cyan-400 hover:text-cyan-300 transition-colors">
                Inicia sesion
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
